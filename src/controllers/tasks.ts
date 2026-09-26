import { Request, Response, NextFunction } from 'express';
import { asyncWrapper } from '../middleware';
import { TaskModel } from '../models';
import { Task } from '../typescript/interfaces';
import { ErrorResponse } from '../utils';

const allowedStatuses: Task['status'][] = ['todo', 'doing', 'done', 'failed'];
const allowedPriorities: Task['priority'][] = ['low', 'medium', 'high'];

interface TaskBody {
  title: string;
  description: string;
  status: Task['status'];
  priority: Task['priority'];
  dueDate: Date | null;
}

const normalizeTaskBody = (body: {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
}): TaskBody => {
  const status = String(body.status || '');
  const priority = String(body.priority || '');

  return {
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    status: allowedStatuses.includes(status as Task['status'])
      ? (status as Task['status'])
      : 'todo',
    priority: allowedPriorities.includes(priority as Task['priority'])
      ? (priority as Task['priority'])
      : 'medium',
    dueDate: body.dueDate ? new Date(body.dueDate) : null
  };
};

export const getTasks = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const tasks = await TaskModel.findAll({
      order: [
        ['status', 'ASC'],
        ['priority', 'DESC'],
        ['createdAt', 'DESC']
      ]
    });

    res.status(200).json({ data: tasks });
  }
);

export const createTask = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const taskBody = normalizeTaskBody(req.body);

    if (!taskBody.title) {
      return next(new ErrorResponse(400, 'Task title is required'));
    }

    const task = await TaskModel.create(taskBody);

    res.status(201).json({ data: task });
  }
);

export const updateTask = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const task = await TaskModel.findByPk(Number(req.params.id));

    if (!task) {
      return next(new ErrorResponse(404, 'Task was not found'));
    }

    const taskBody = normalizeTaskBody({
      ...task.get({ plain: true }),
      ...req.body
    });

    if (!taskBody.title) {
      return next(new ErrorResponse(400, 'Task title is required'));
    }

    await task.update(taskBody);

    res.status(200).json({ data: task });
  }
);

export const deleteTask = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const task = await TaskModel.findByPk(Number(req.params.id));

    if (!task) {
      return next(new ErrorResponse(404, 'Task was not found'));
    }

    await task.destroy();

    res.status(200).json({ data: {} });
  }
);
