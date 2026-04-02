// ─────────────────────────────────────────────
//  Cascade AI — Task Scheduler (node-cron)
// ─────────────────────────────────────────────

import cron, { type ScheduledTask as CronTask } from 'node-cron';
import type { ScheduledTask } from '../types.js';
import type { MemoryStore } from '../memory/store.js';

type TaskRunner = (task: ScheduledTask) => Promise<void>;

export class TaskScheduler {
  private cronJobs: Map<string, CronTask> = new Map();
  private store: MemoryStore;
  private runner: TaskRunner;

  constructor(store: MemoryStore, runner: TaskRunner) {
    this.store = store;
    this.runner = runner;
  }

  start(): void {
    const tasks = this.store.listScheduledTasks();
    for (const task of tasks) {
      if (task.enabled) this.schedule(task);
    }
  }

  stop(): void {
    for (const job of this.cronJobs.values()) job.stop();
    this.cronJobs.clear();
  }

  schedule(task: ScheduledTask): void {
    if (!cron.validate(task.cronExpression)) {
      throw new Error(`Invalid cron expression: ${task.cronExpression}`);
    }

    const job = cron.schedule(task.cronExpression, async () => {
      task.lastRun = new Date().toISOString();
      this.store.saveScheduledTask(task);
      await this.runner(task);
    }, { timezone: 'UTC' });

    this.cronJobs.set(task.id, job);
  }

  unschedule(taskId: string): void {
    this.cronJobs.get(taskId)?.stop();
    this.cronJobs.delete(taskId);
  }

  add(task: ScheduledTask): void {
    this.store.saveScheduledTask(task);
    if (task.enabled) this.schedule(task);
  }

  remove(taskId: string): void {
    this.unschedule(taskId);
    this.store.deleteScheduledTask(taskId);
  }

  list(): ScheduledTask[] {
    return this.store.listScheduledTasks();
  }

  isRunning(taskId: string): boolean {
    return this.cronJobs.has(taskId);
  }

  static validateCron(expression: string): boolean {
    return cron.validate(expression);
  }
}
