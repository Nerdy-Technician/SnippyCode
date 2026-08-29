import { SearchQuery } from '../typescript/interfaces';

const FILTER_PATTERN = /(tags|lang|collection):[a-zA-Z0-9_-]+(,[a-zA-Z0-9_-]+)*/g;

export const searchParser = (rawQuery: string): SearchQuery => {
  const tags = extractFilters(rawQuery, 'tags');
  const languages = extractFilters(rawQuery, 'lang');
  const collections = extractFilters(rawQuery, 'collection');
  const query = rawQuery.replaceAll(FILTER_PATTERN, '');

  return {
    query: query.trim(),
    tags,
    languages,
    collections
  };
};

const extractFilters = (query: string, filter: string): string[] => {
  const regex = new RegExp(filter + ':[a-zA-Z0-9_-]+(,[a-zA-Z0-9_-]+)*');
  const matcher = query.match(regex);

  if (!matcher) {
    return [];
  }

  return matcher[0].split(':')[1].split(',').filter(Boolean);
};
