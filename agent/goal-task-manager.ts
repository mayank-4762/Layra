import { AgentState, Task, TaskStatus } from './state';

/** Goal/task bookkeeping used by the unified runtime and compatible integrations. */
export class GoalTaskManager {
  private readonly state: AgentState;
  constructor(state: AgentState) { this.state = state; }

  setGoal(goal: string): void {
    const value = goal.trim();
    if (!value) throw new Error('Goal cannot be empty');
    if (this.state.currentGoal && this.state.currentGoal !== value) this.state.goalHistory.push(this.state.currentGoal);
    this.state.currentGoal = value;
    this.state.activeTasks = [];
    this.state.taskQueue = [{
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      goal: value,
      description: `Process goal: ${value}`,
      priority: 1,
      status: TaskStatus.PENDING,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      assignedTo: null,
      result: null,
      error: null,
      dependencies: [],
      metadata: { source: 'goal' }
    }];
  }

  getNextTask(): Task | null {
    const completed = new Set(this.state.completedTasks.map(task => task.id));
    const ready = this.state.taskQueue.filter(task => task.status === TaskStatus.PENDING && task.dependencies.every(dep => completed.has(dep)));
    ready.sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime());
    return ready[0] || null;
  }

  startTask(taskId: string, assignedTo: string): boolean {
    const task = this.state.taskQueue.find(item => item.id === taskId);
    if (!task || task.status !== TaskStatus.PENDING) return false;
    task.status = TaskStatus.IN_PROGRESS;
    task.startedAt = new Date();
    task.assignedTo = assignedTo;
    return true;
  }

  completeTask(taskId: string, result: any): boolean {
    const index = this.state.taskQueue.findIndex(item => item.id === taskId);
    if (index < 0) return false;
    const task = this.state.taskQueue[index];
    task.status = TaskStatus.COMPLETED;
    task.completedAt = new Date();
    task.result = result;
    this.state.taskQueue.splice(index, 1);
    this.state.completedTasks.push(task);
    return true;
  }

  failTask(taskId: string, error: string): boolean {
    const index = this.state.taskQueue.findIndex(item => item.id === taskId);
    if (index < 0) return false;
    const task = this.state.taskQueue[index];
    task.status = TaskStatus.FAILED;
    task.completedAt = new Date();
    task.error = error;
    this.state.taskQueue.splice(index, 1);
    this.state.failedTasks.push(task);
    return true;
  }

  blockTask(taskId: string, reason: string): boolean {
    const task = this.state.taskQueue.find(item => item.id === taskId);
    if (!task) return false;
    task.status = TaskStatus.BLOCKED;
    task.metadata = { ...task.metadata, blockReason: reason };
    return true;
  }

  getPendingTasks(): Task[] { return this.state.taskQueue.filter(task => task.status === TaskStatus.PENDING); }
  getInProgressTasks(): Task[] { return this.state.taskQueue.filter(task => task.status === TaskStatus.IN_PROGRESS); }
  getCompletedTasks(): Task[] { return [...this.state.completedTasks]; }
  getFailedTasks(): Task[] { return [...this.state.failedTasks]; }

  getGoalStatistics() {
    return {
      totalGoals: this.state.goalHistory.length + (this.state.currentGoal ? 1 : 0),
      completedGoals: this.state.goalHistory.length,
      pendingGoals: this.state.currentGoal ? 1 : 0,
      currentGoal: this.state.currentGoal
    };
  }

  clearGoalHistory(keepRecent = 5): void {
    if (this.state.goalHistory.length > keepRecent) this.state.goalHistory = this.state.goalHistory.slice(-keepRecent);
  }

  reset(): void {
    this.state.currentGoal = null;
    this.state.goalHistory = [];
    this.state.goalQueue = [];
    this.state.activeTasks = [];
    this.state.completedTasks = [];
    this.state.failedTasks = [];
    this.state.taskQueue = [];
  }
}
