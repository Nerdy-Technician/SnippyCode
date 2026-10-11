import { DataTypes, QueryInterface } from 'sequelize';

const { TEXT } = DataTypes;

/**
 * Snippet variable definitions (name, type, default, required, description),
 * per-step values on runbook steps, and stored values on schedules.
 * Existing rows get empty lists, so they behave exactly as before.
 */
export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.addColumn('snippets', 'variables', { type: TEXT, allowNull: false, defaultValue: '[]' });
  await queryInterface.addColumn('runbook_steps', 'values', { type: TEXT, allowNull: false, defaultValue: '{}' });
  await queryInterface.addColumn('schedules', 'variables', { type: TEXT, allowNull: false, defaultValue: '{}' });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.removeColumn('schedules', 'variables');
  await queryInterface.removeColumn('runbook_steps', 'values');
  await queryInterface.removeColumn('snippets', 'variables');
};
