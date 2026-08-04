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
    fileName
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

  req.body = {
    title: title.trim(),
    description: typeof description === 'string' ? description.trim() : '',
    language: language.trim().toLowerCase(),
    code,
    docs: typeof docs === 'string' ? docs : '',
    isPinned: Boolean(isPinned) ? 1 : 0,
    tags: Array.isArray(tags) ? tags : [],
    collection: typeof collection === 'string' && collection.trim() ? collection.trim() : 'General',
    fileName: typeof fileName === 'string' ? fileName.trim() : ''
  };

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
