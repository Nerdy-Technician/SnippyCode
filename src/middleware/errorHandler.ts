import { Request, Response, NextFunction } from 'express';
import { ErrorResponse, Logger } from '../utils';

const logger = new Logger('errorHandler');

export const errorHandler = (
  err: ErrorResponse,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.log(err.message, 'ERROR');
  const statusCode = err.statusCode || 500;

  res.status(statusCode).json({
    error: statusCode >= 500 ? 'Internal Server Error' : err.message
  });
};
