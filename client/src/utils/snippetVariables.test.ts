import { compareWithCode, definitionProblems, mergeDefinitions, newDefinition, parseDefinitionsJson, runValueProblems } from './snippetVariables';

describe('snippet variable definitions', () => {
  const defs = [
    { ...newDefinition('DIR'), required: true },
    { ...newDefinition('DAYS', '7'), type: 'number' as const, required: true },
    { ...newDefinition('MODE'), type: 'choice' as const, choices: ['a', 'b'] },
    { ...newDefinition('TOKEN'), type: 'secret-ref' as const, ref: 'VAULT', required: true }
  ];

  it('finds missing and unused definitions', () => {
    const result = compareWithCode('ls {{DIR}} {{NEW:1}}', defs);
    expect(result.missing.map(item => item.name)).toEqual(['NEW']);
    expect(result.unused).toEqual(['DAYS', 'MODE', 'TOKEN']);
  });

  it('checks run values: required and types, never secret refs', () => {
    expect(runValueProblems(defs, {})).toEqual(['DIR needs a value']);
    expect(runValueProblems(defs, { DIR: '/x', DAYS: 'soon', MODE: 'c' })).toEqual(['DAYS must be a number', 'MODE must be one of a, b']);
    expect(runValueProblems(defs, { DIR: '/x' })).toEqual([]);
  });

  it('flags bad definitions', () => {
    expect(definitionProblems([newDefinition('bad'), { ...newDefinition('C'), type: 'choice' }])).toEqual([
      '"bad" is not a valid name (UPPER_SNAKE)',
      'C needs at least one choice'
    ]);
  });

  it('imports JSON lists or snippet exports and never duplicates names', () => {
    const parsed = parseDefinitionsJson('{"variables":[{"name":"dir","type":"secret-ref","default":"leak"},{"name":"X"}]}');
    expect(parsed[0]).toMatchObject({ name: 'DIR', type: 'secret-ref', default: '' });
    expect(mergeDefinitions(defs, parsed).map(def => def.name)).toEqual(['DIR', 'DAYS', 'MODE', 'TOKEN', 'X']);
    expect(() => parseDefinitionsJson('{"nope":1}')).toThrow();
  });
});
