import aliasesData from '../data/aliases_raw.json';

export const findLanguage = (language: string): boolean => {
  const search = language.toLowerCase();
  return (aliasesData as { aliases: string[] }).aliases.some(alias => alias === search);
};
