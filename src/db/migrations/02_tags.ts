import { Logger } from '../../utils';
import { DataTypes, QueryInterface } from 'sequelize';

const { STRING, INTEGER } = DataTypes;
const logger = new Logger('migration[02]');

interface ExistingSnippet {
  id: number;
  language: string;
}

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.createTable('tags', {
    id: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: STRING,
      allowNull: false,
      unique: true
    }
  });

  await queryInterface.createTable('snippets_tags', {
    id: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true
    },
    snippet_id: {
      type: INTEGER,
      allowNull: false
    },
    tag_id: {
      type: INTEGER,
      allowNull: false
    }
  });

  // Create new tags from language column without importing current models.
  const [snippets] = (await queryInterface.sequelize.query(
    'SELECT id, language FROM snippets'
  )) as unknown as [ExistingSnippet[]];
  const languages = snippets.map(snippet => snippet.language);
  const uniqueLanguages = [...new Set(languages)];
  const tags: { id: number; name: string }[] = [];

  if (snippets.length > 0) {
    for (const language of uniqueLanguages) {
      try {
        const [createdTags] = (await queryInterface.sequelize.query(
          'INSERT INTO tags (name) VALUES (:language) RETURNING id, name',
          { replacements: { language } }
        )) as unknown as [{ id: number; name: string }[]];
        tags.push(createdTags[0]);
      } catch (err) {
        logger.log('Error while creating new tags');
      }
    }

    // Assign tag to snippet
    for (const snippet of snippets) {
      try {
        const tag = tags.find(tag => tag.name == snippet.language);

        if (tag) {
          await queryInterface.sequelize.query(
            'INSERT INTO snippets_tags (snippet_id, tag_id) VALUES (:snippetId, :tagId)',
            { replacements: { snippetId: snippet.id, tagId: tag.id } }
          );
        }
      } catch (err) {
        logger.log('Error while assigning tags to snippets');
      }
    }
  }
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.dropTable('tags');
  await queryInterface.dropTable('snippets_tags');
};
