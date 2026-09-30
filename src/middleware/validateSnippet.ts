import { Request, Response, NextFunction } from 'express';
import { ErrorResponse } from '../utils';

const MAX = {
  title: 120,
  description: 500,
  language: 40,
  code: 150000,
  docs: 50000,
  tag: 40,
  tags: 20,
  collection: 80,
  fileName: 120
};

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const tooLong = (value: string | undefined, max: number): boolean =>
  typeof value === 'string' && value.length > max;

const isBooleanLike = (value: unknown): boolean =>
  typeof value === 'boolean' || value === 0 || value === 1;

export const validateSnippetBody = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const {
    title,
    description,
    language,
    code,
    docs,
    tags,
    isPinned,
    collection,
    fileName,
    isPublic
  } = req.body;

  if (!isText(title) || !isText(language) || !isText(code)) {
    return next(
      new ErrorResponse(400, 'Title, language, and code must be non-empty text')
    );
  }

  if (
    tooLong(title, MAX.title) ||
    tooLong(description, MAX.description) ||
    tooLong(language, MAX.language) ||
    tooLong(code, MAX.code) ||
    tooLong(docs, MAX.docs) ||
    tooLong(collection, MAX.collection) ||
    tooLong(fileName, MAX.fileName)
  ) {
    return next(new ErrorResponse(400, 'Snippet content exceeds allowed length'));
  }

  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > MAX.tags) {
      return next(new ErrorResponse(400, 'Tags must be a short list'));
    }

    if (tags.some(tag => typeof tag !== 'string' || tag.length > MAX.tag)) {
      return next(new ErrorResponse(400, 'Tags must be text values'));
    }
  }

  if (isPinned !== undefined && !isBooleanLike(isPinned)) {
    return next(new ErrorResponse(400, 'Pin state must be true or false'));
  }

  if (isPublic !== undefined && !isBooleanLike(isPublic)) {
    return next(new ErrorResponse(400, 'Public state must be true or false'));
  }

  // Only normalise fields the client actually sent. Omitted optional fields
  // are left undefined so an update keeps the stored value instead of
  // silently resetting it (for example, a stale client that leaves out
  // isPublic must not unpublish a shared snippet). Create applies defaults.
  const body: { [key: string]: unknown } = {
    title: title.trim(),
    language: language.trim().toLowerCase(),
    code
  };

  if (description !== undefined) {
    body.description = typeof description === 'string' ? description.trim() : '';
  }

  if (docs !== undefined) {
    body.docs = typeof docs === 'string' ? docs : '';
  }

  if (isPinned !== undefined) {
    body.isPinned = isPinned ? 1 : 0;
  }

  if (tags !== undefined) {
    body.tags = tags;
  }

  if (collection !== undefined) {
    body.collection =
      typeof collection === 'string' && collection.trim() ? collection.trim() : 'General';
  }

  if (fileName !== undefined) {
    body.fileName = typeof fileName === 'string' ? fileName.trim() : '';
  }

  if (isPublic !== undefined) {
    body.isPublic = Boolean(isPublic);
  }

  req.body = body;

  next();
};

/**
 * Validates PATCH /api/snippets/:id, which only changes the pin and public
 * flags. Toggles use this instead of re-sending a whole (possibly stale)
 * snippet through PUT.
 */
export const validateSnippetFlags = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const { isPinned, isPublic } = req.body || {};
  const unknownKeys = Object.keys(req.body || {}).filter(
    key => !['isPinned', 'isPublic'].includes(key)
  );

  if (unknownKeys.length > 0) {
    return next(
      new ErrorResponse(400, `Only isPinned and isPublic can be patched; got ${unknownKeys.join(', ')}`)
    );
  }

  if (isPinned === undefined && isPublic === undefined) {
    return next(new ErrorResponse(400, 'Send isPinned and/or isPublic'));
  }

  if (isPinned !== undefined && !isBooleanLike(isPinned)) {
    return next(new ErrorResponse(400, 'Pin state must be true or false'));
  }

  if (isPublic !== undefined && !isBooleanLike(isPublic)) {
    return next(new ErrorResponse(400, 'Public state must be true or false'));
  }

  const body: { isPinned?: number; isPublic?: boolean } = {};

  if (isPinned !== undefined) {
    body.isPinned = isPinned ? 1 : 0;
  }

  if (isPublic !== undefined) {
    body.isPublic = Boolean(isPublic);
  }

  req.body = body;

  next();
};

export const validateSnippetId = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return next(new ErrorResponse(400, 'Snippet id must be a positive integer'));
  }

  next();
};
