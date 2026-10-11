import { DataTypes, QueryInterface } from 'sequelize';

const { STRING, TEXT } = DataTypes;

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  // 'snippet' for library snippets, 'tool' for built-in device tools
  await queryInterface.addColumn('agent_jobs', 'kind', {
    type: STRING(20),
    allowNull: false,
    defaultValue: 'snippet'
  });
  await queryInterface.addColumn('agent_jobs', 'tool', {
    type: STRING(40),
    allowNull: true
  });
  await queryInterface.addColumn('snippet_runs', 'kind', {
    type: STRING(20),
    allowNull: false,
    defaultValue: 'snippet'
  });
  // Latest results of each read-only tool (services, tasks, software...)
  await queryInterface.addColumn('devices', 'inventory', {
    type: TEXT,
    allowNull: false,
    defaultValue: '{}'
  });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.removeColumn('devices', 'inventory');
  await queryInterface.removeColumn('snippet_runs', 'kind');
  await queryInterface.removeColumn('agent_jobs', 'tool');
  await queryInterface.removeColumn('agent_jobs', 'kind');
};
