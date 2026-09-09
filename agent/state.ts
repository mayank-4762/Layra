export interface AgentState {
  id: string;
  name: string;
  version: string;
  currentGoal: string | null;
  goalHistory: string[];
  goalQueue: string[];
  activeTasks: Task[];
  completedTasks: Task[];
  failedTasks: Task[];
  taskQueue: Task[];
  workingMemory: Record<string, any>;
  shortTermMemory: Record<string, any>;
  longTermMemory: Record<string, any>;
  currentPlan: PlanStep[];
  planningHistory: PlanStep[][];
  reflections: Reflection[];
  lastActionResult: ActionResult | null;
  executionHistory: ActionResult[];
  availableTools: Tool[];
  toolPermissions: ToolPermission[];
  successRate: number;
  averageResponseTime: number;
  totalActions: number;
  createdAt: Date;
  lastUpdated: Date;
  lastActiveAt: Date;
}

export interface Task {
  id: string;
  goal: string;
  description: string;
  priority: number;
  status: TaskStatus;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  assignedTo: string | null;
  result: any | null;
  error: string | null;
  dependencies: string[];
  metadata: Record<string, any>;
}

export enum TaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  BLOCKED = 'blocked'
}

export interface PlanStep {
  id: string;
  description: string;
  tool: string;
  parameters: Record<string, any>;
  dependsOn: string[];
  estimatedDuration: number;
  actualDuration: number | null;
  status: PlanStepStatus;
  result: any | null;
  error: string | null;
  priority: number;
  riskLevel: 'low' | 'medium' | 'high';
  verificationRequired: boolean;
  expectedOutcome: string;
  /** Explicit skill procedures this step is intended to follow. */
  skillRefs?: string[];
}

export enum PlanStepStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped'
}

export interface Reflection {
  id: string;
  type: ReflectionType;
  content: string;
  confidence: number;
  source: string[];
  createdAt: Date;
  metadata: Record<string, any>;
}

export enum ReflectionType {
  INSIGHT = 'insight',
  PATTERN = 'pattern',
  CORRECTION = 'correction',
  QUESTION = 'question',
  HYPOTHESIS = 'hypothesis',
  LESSON = 'lesson'
}

export interface ActionResult {
  actionId: string;
  stepId: string | null;
  tool: string;
  success: boolean;
  result: any;
  error: string | null;
  executionTime: number;
  timestamp: Date;
  metadata: Record<string, any>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  returns: string;
  permissions: string[];
  isAvailable: boolean;
}

export interface ToolPermission {
  toolName: string;
  granted: boolean;
  grantedAt: Date;
  grantedBy: string;
  reason: string;
}
