import { Optional } from 'sequelize';

export interface Tag {
  id: number;
  name: string;
  color?: string | null;
}

export interface TagCreationAttributes extends Optional<Tag, 'id' | 'color'> {}
