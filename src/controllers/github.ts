import { Response } from 'express';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import { SnippetModel, TagModel } from '../models';
import { ErrorResponse, upsertGithubFile } from '../utils';

const extensionForLanguage = (language: string): string => {
  const normalized = language.toLowerCase();
  const extensions: { [key: string]: string } = {
    bash: 'sh',
    shell: 'sh',
    dockerfile: 'Dockerfile',
    javascript: 'js',
    typescript: 'ts',
    python: 'py',
    markdown: 'md',
    yaml: 'yml'
  };

  return extensions[normalized] || normalized || 'txt';
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);

const markdownForSnippet = (snippet: {
  title: string;
  description?: string;
  language: string;
  code: string;
  docs?: string;
  tags?: string[];
}): string =>
  [
    `# ${snippet.title}`,
    '',
    snippet.description || '',
    '',
    `Language: ${snippet.language}`,
    `Tags: ${(snippet.tags || []).join(', ') || 'none'}`,
    '',
    '```' + snippet.language,
    snippet.code,
    '```',
    '',
    snippet.docs ? '## Documentation' : '',
    snippet.docs || ''
  ]
    .filter(line => line !== undefined)
    .join('\n');

export const exportSnippetsToGithub = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!process.env.GITHUB_TOKEN) {
      throw new ErrorResponse(400, 'GITHUB_TOKEN is not configured');
    }

    const basePath = process.env.GITHUB_SNIPPETS_PATH || 'snippets';
    const snippets = await SnippetModel.findAll({
      include: {
        model: TagModel,
        as: 'tags',
        attributes: ['name'],
        through: {
          attributes: []
        }
      }
    });

    const exported = [];

    for (const snippet of snippets) {
      const rawSnippet = snippet.get({ plain: true });
      const tags = rawSnippet.tags?.map(tag => tag.name) || [];
      const slug = slugify(rawSnippet.title) || `snippet-${rawSnippet.id}`;
      const codeExtension = extensionForLanguage(rawSnippet.language);
      const codePath =
        codeExtension === 'Dockerfile'
          ? `${basePath}/${slug}/Dockerfile`
          : `${basePath}/${slug}/snippet.${codeExtension}`;
      const docPath = `${basePath}/${slug}/README.md`;

      exported.push(
        await upsertGithubFile(
          codePath,
          rawSnippet.code,
          `Export snippet code: ${rawSnippet.title}`
        )
      );
      exported.push(
        await upsertGithubFile(
          docPath,
          markdownForSnippet({
            ...rawSnippet,
            tags
          }),
          `Export snippet docs: ${rawSnippet.title}`
        )
      );
    }

    res.status(200).json({
      data: {
        count: snippets.length,
        files: exported
      }
    });
  }
);
