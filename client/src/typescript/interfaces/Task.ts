import { Model } from '.';

export interface Task extends Model {
  title: string;
  description: string;
  status: 'todo' | 'doing' | 'done' | 'failed';
  priority: 'low' | 'medium' | 'high';
  dueDate?: string | null;
}

export interface NewTask {
  title: string;
  description: string;
  status: 'todo' | 'doing' | 'done' | 'failed';
  priority: 'low' | 'medium' | 'high';
  dueDate?: string | null;
}
