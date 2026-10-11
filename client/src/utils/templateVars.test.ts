import { findTemplateVariables, renderTemplate } from './templateVars';

// Must behave exactly like src/utils/templateVars.ts on the server, or raw
// links and their checksums stop matching what the page shows.
describe('client template variables', () => {
  test('finds names and defaults', () => {
    expect(findTemplateVariables('{{HOST}} {{PORT:22}} ${{ secrets.X }} {{name}}')).toEqual([
      { name: 'HOST', defaultValue: null },
      { name: 'PORT', defaultValue: '22' }
    ]);
  });

  test('renders with precedence and leaves unknowns', () => {
    expect(renderTemplate('{{A}}-{{B:b}}-{{C}}', { A: 'a' }, { A: 'x', B: 'y' })).toBe('a-y-{{C}}');
  });
});
