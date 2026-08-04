import { Optional } from 'sequelize';
import { Model } from '.';

export interface Task extends Model {
  title: string;
  description: string;
  status: 'todo' | 'doing' | 'done' | 'failed';
  priority: 'low' | 'medium' | 'high';
  dueDate?: Date | null;
}

export interface TaskCreationAttributes
  extends Optional<Task, 'id' | 'createdAt' | 'updatedAt' | 'description' | 'status' | 'priority' | 'dueDate'> {}
