/**
 * Replays a held request through the same route handler once it is
 * approved, as the requester, so the run goes through exactly the same
 * validation and access checks as when it was asked for. The approval id
 * travels on the request object itself, never in the body, so a client
 * cannot claim one.
 */
export const APPROVED_RUN = Symbol('approvedRun');

export const approvedRunId = (req: unknown): number | null =>
  ((req as any)?.[APPROVED_RUN] as number | undefined) || null;

type Handler = (req: any, res: any, next: (err?: unknown) => void) => unknown;

export const replayHandler = (
  handler: Handler,
  options: { params: Record<string, string>; body: unknown; user: unknown; approvalId: number }
): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const req: any = {
      params: options.params,
      body: options.body || {},
      query: {},
      headers: {},
      user: options.user,
      [APPROVED_RUN]: options.approvalId
    };
    let status = 200;
    const res: any = {
      status(code: number) {
        status = code;
        return res;
      },
      json(body: unknown) {
        resolve({ status, body });
        return res;
      }
    };
    Promise.resolve(
      handler(req, res, err => reject(err instanceof Error ? err : new Error(String(err || 'Run failed'))))
    ).catch(reject);
  });
