import { Model } from '.';
import { Optional } from 'sequelize';

export interface Variable extends Model {
  name: string;
  value: string;
  description: string;
  userId: number | null;
  siteId: number | null;
  isSecret: boolean;
}

export interface VariableCreationAttributes
  extends Optional<Variable, 'id' | 'createdAt' | 'updatedAt' | 'description' | 'siteId' | 'isSecret'> {}
