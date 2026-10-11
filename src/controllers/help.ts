import { NextFunction, Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sequelize } from '../db';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import { RunbookModel, RunbookStepModel, SnippetModel, VariableModel } from '../models';
import {
  ErrorResponse,
  auditLog,
  cleanVariableDefinitions,
  createTags,
  findAccessibleSite,
  findTemplateVariables,
  requestIp,
  tagParser
} from '../utils';

// Docs ship with the app (docs/ is copied into the image), so help works offline
const docsDir = (): string => process.env.DOCS_DIR || join(process.cwd(), 'docs');
const HELP_DOCS: { [slug: string]: string } = { playbooks: 'playbooks.md', runbooks: 'playbooks.md' };
const EXAMPLE_FILE = 'examples/linux-disk-cleanup.runbook.json';
const IMPORT_LOCK = 7_311_844;

/**
 * @description An in-app help page as markdown
 * @route /api/help/:doc
 * @request GET
 */
export const getHelpDoc = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const file = HELP_DOCS[String(req.params.doc)];

    if (!file) {
      return next(new ErrorResponse(404, 'Help page was not found'));
    }

    try {
      res.status(200).json({ data: { markdown: readFileSync(join(docsDir(), file), 'utf8') } });
    } catch {
      next(new ErrorResponse(404, 'Help page was not found'));
    }
  }
);

interface ExampleFile {
  snippets: Array<{
    title: string;
    description: string;
    language: string;
    code: string;
    docs: string;
    collection: string;
    fileName: string;
    tags: string[];
    variables?: unknown[];
  }>;
  runbook: {
    title: string;
    description: string;
    steps: Array<{ snippet?: string; title?: string; note?: string }>;
  };
}

export const readExampleRunbook = (): ExampleFile =>
  JSON.parse(readFileSync(join(docsDir(), EXAMPLE_FILE), 'utf8'));

/**
 * @description Import the example runbook (its snippets and runbook, plus
 * site variables with the defaults for the chosen site). Running it again
 * reuses what is already there, so nothing is duplicated.
 * @route /api/runbooks/example
 * @request POST
 */
export const importExampleRunbook = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const site = await findAccessibleSite(req.user || {}, req.body?.siteId);

    if (!site) {
      return next(new ErrorResponse(404, 'Site was not found'));
    }

    const example = readExampleRunbook();

    const result = await sequelize.transaction(async transaction => {
      // Serialise imports so two clicks cannot both create
      await sequelize.query('SELECT pg_advisory_xact_lock(:key)', { replacements: { key: IMPORT_LOCK }, transaction });
      const created = { snippets: 0, runbook: false, variables: 0 };
      const ids = new Map<string, number>();
      const newTags: Array<{ id: number; tags: string[] }> = [];

      for (const item of example.snippets) {
        let snippet = await SnippetModel.findOne({ where: { title: item.title, collection: item.collection }, transaction });
        if (!snippet) {
          snippet = await SnippetModel.create(
            {
              title: item.title,
              description: item.description,
              language: item.language,
              code: item.code,
              docs: item.docs || '',
              collection: item.collection,
              fileName: item.fileName || '',
              variables: cleanVariableDefinitions(item.variables || []),
              isPinned: 0
            },
            { transaction }
          );
          newTags.push({ id: snippet.id, tags: [...(item.tags || []), item.language] });
          created.snippets += 1;
        }
        ids.set(item.title, snippet.id);
      }

      let runbook = await RunbookModel.findOne({ where: { title: example.runbook.title }, transaction });
      if (!runbook) {
        runbook = await RunbookModel.create(
          { title: example.runbook.title, description: example.runbook.description, createdBy: req.user?.id || null },
          { transaction }
        );
        for (const [position, step] of example.runbook.steps.entries()) {
          await RunbookStepModel.create(
            {
              runbookId: runbook.id,
              position,
              snippetId: step.snippet ? ids.get(step.snippet) || null : null,
              title: step.title || '',
              note: step.note || ''
            },
            { transaction }
          );
        }
        created.runbook = true;
      }

      // Site variables with the defaults, so the site can tune them
      const defaults = new Map<string, string>();
      example.snippets.forEach(item =>
        findTemplateVariables(item.code).forEach(variable => {
          if (variable.defaultValue !== null && !defaults.has(variable.name)) {
            defaults.set(variable.name, variable.defaultValue);
          }
        })
      );
      for (const [name, value] of defaults) {
        const existing = await VariableModel.findOne({ where: { name, siteId: site.id, userId: null }, transaction });
        if (!existing) {
          await VariableModel.create(
            { name, value, description: `Used by the "${example.runbook.title}" example runbook`, siteId: site.id, userId: null, isSecret: false },
            { transaction }
          );
          created.variables += 1;
        }
      }

      return { runbookId: runbook.id, created, newTags };
    });

    // Tags use their own queries, so add them once the snippets are committed
    for (const item of result.newTags) {
      await createTags(tagParser(item.tags), item.id);
    }

    await auditLog('runbook.example_imported', {
      userId: req.user?.id || null,
      ipAddress: requestIp(req),
      target: `runbook:${result.runbookId}`,
      metadata: { site: site.name, siteId: site.id, ...result.created }
    });

    res
      .status(result.created.runbook || result.created.snippets ? 201 : 200)
      .json({ data: { runbookId: result.runbookId, created: result.created } });
  }
);
