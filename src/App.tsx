import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Subtask = {
  id: string;
  parentId?: string;
  title: string;
  start: string;
  end: string;
  done: boolean;
  completedAt?: string;
};

type RecurrenceRule = {
  frequency: "daily" | "weekly" | "monthly";
  interval: number;
  estimatedCount: number;
  active: boolean;
  endedAt?: string;
};

type Task = {
  id: string;
  title: string;
  project: string;
  color: string;
  start: string;
  end: string;
  notes: string;
  subtasks: Subtask[];
  completedAt?: string;
  showInGantt?: boolean;
  recurrence?: RecurrenceRule;
  seriesId?: string;
  occurrenceIndex?: number;
  copiedFromId?: string;
  starred?: boolean;
  ganttOrder?: number;
};

type Category = { id: string; name: string; color: string };
type GanttMode = "body" | "popup" | "expanded";
type View = "calendar" | "gantt" | "tasks";
type AppState = {
  version: 4;
  tasks: Task[];
  categories: Category[];
  preferences: {
    ganttMode: GanttMode;
    zoom: "day" | "week" | "month";
    rangeMode: "fit" | "month" | "quarter" | "custom";
    customStart: string;
    customEnd: string;
    fontScale: number;
    density: "compact" | "standard" | "comfortable";
    sidebarWidth: "narrow" | "standard" | "wide";
    detailVisible: boolean;
    expandedTaskIds: string[];
  };
};

const pad = (value: number) => String(value).padStart(2, "0");
const toDateKey = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const plusDays = (key: string, count: number) => {
  const date = new Date(`${key}T12:00:00`);
  date.setDate(date.getDate() + count);
  return toDateKey(date);
};
const dayDiff = (a: string, b: string) =>
  Math.round(
    (new Date(`${b}T12:00:00`).getTime() -
      new Date(`${a}T12:00:00`).getTime()) /
      86400000,
  );
const uid = () => Math.random().toString(36).slice(2, 10);
const today = new Date();
const todayKey = toDateKey(today);
const STORAGE_KEY = "mori-planner.state.v2";
const LEGACY_STORAGE_KEY = "mori-planner.tasks.v1";
const colors = ["#315efb", "#8b5cf6", "#10a37f", "#ec4899", "#f59e0b", "#0891b2"];

const descendantsOf = (subtasks: Subtask[], id: string) => {
  const ids = new Set<string>();
  const visit = (parentId: string) => {
    subtasks.filter((sub) => sub.parentId === parentId).forEach((sub) => {
      ids.add(sub.id);
      visit(sub.id);
    });
  };
  visit(id);
  return ids;
};

const subtaskDepth = (subtasks: Subtask[], subtask: Subtask) => {
  let depth = 0;
  let parentId = subtask.parentId;
  const visited = new Set<string>();
  while (parentId && depth < 4 && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = subtasks.find((item) => item.id === parentId)?.parentId;
  }
  return depth;
};

const leafSubtasks = (subtasks: Subtask[]) => {
  const parentIds = new Set(subtasks.map((sub) => sub.parentId).filter(Boolean));
  return subtasks.filter((sub) => !parentIds.has(sub.id));
};

const normalizeParentCompletion = (subtasks: Subtask[]) => {
  const next = subtasks.map((sub) => ({ ...sub }));
  for (let pass = 0; pass < 5; pass += 1) {
    next.forEach((parent) => {
      const children = next.filter((child) => child.parentId === parent.id);
      if (!children.length) return;
      const done = children.every((child) => child.done);
      parent.start = children.reduce((min, child) => child.start < min ? child.start : min, children[0].start);
      parent.end = children.reduce((max, child) => child.end > max ? child.end : max, children[0].end);
      parent.done = done;
      parent.completedAt = done ? parent.completedAt ?? todayKey : undefined;
    });
  }
  return next;
};

const shiftDate = (key: string, frequency: RecurrenceRule["frequency"], interval: number, occurrence: number) => {
  const date = new Date(`${key}T12:00:00`);
  const amount = interval * occurrence;
  if (frequency === "daily") date.setDate(date.getDate() + amount);
  if (frequency === "weekly") date.setDate(date.getDate() + amount * 7);
  if (frequency === "monthly") {
    const originalDay = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + amount);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(originalDay, lastDay));
  }
  return toDateKey(date);
};

const cloneOccurrence = (source: Task, occurrenceIndex: number, seriesId: string): Task => {
  const rule = source.recurrence!;
  const idMap = new Map(source.subtasks.map((sub) => [sub.id, uid()]));
  return {
    ...source,
    id: occurrenceIndex === 1 ? source.id : uid(),
    title: `${source.title.replace(/ · 第 \d+ 期$/, "")} · 第 ${occurrenceIndex} 期`,
    start: shiftDate(source.start, rule.frequency, rule.interval, occurrenceIndex - 1),
    end: shiftDate(source.end, rule.frequency, rule.interval, occurrenceIndex - 1),
    completedAt: undefined,
    seriesId,
    occurrenceIndex,
    subtasks: source.subtasks.map((sub) => ({
      ...sub,
      id: idMap.get(sub.id)!,
      parentId: sub.parentId ? idMap.get(sub.parentId) : undefined,
      start: shiftDate(sub.start, rule.frequency, rule.interval, occurrenceIndex - 1),
      end: shiftDate(sub.end, rule.frequency, rule.interval, occurrenceIndex - 1),
      done: false,
      completedAt: undefined,
    })),
  };
};

const defaultCategories: Category[] = [
  { id: "product", name: "产品", color: "#315efb" },
  { id: "research", name: "研究", color: "#8b5cf6" },
  { id: "operations", name: "运营", color: "#ec4899" },
  { id: "personal", name: "个人", color: "#10a37f" },
  { id: "work", name: "工作", color: "#f59e0b" },
];

const seedTasks: Task[] = [
  {
    id: "launch",
    title: "夏季产品发布",
    project: "产品",
    color: "#315efb",
    start: plusDays(todayKey, -2),
    end: plusDays(todayKey, 5),
    notes: "完成发布页面、内容与渠道准备。",
    subtasks: [
      { id: "l1", title: "确定发布范围", start: plusDays(todayKey, -2), end: plusDays(todayKey, -1), done: true },
      { id: "l2", title: "完成视觉与文案", start: todayKey, end: plusDays(todayKey, 2), done: false },
      { id: "l3", title: "上线前检查", start: plusDays(todayKey, 3), end: plusDays(todayKey, 5), done: false },
    ],
  },
  {
    id: "research",
    title: "用户研究冲刺",
    project: "研究",
    color: "#8b5cf6",
    start: plusDays(todayKey, 1),
    end: plusDays(todayKey, 8),
    notes: "访谈核心用户，形成机会地图。",
    subtasks: [
      { id: "r1", title: "招募访谈对象", start: plusDays(todayKey, 1), end: plusDays(todayKey, 3), done: false },
      { id: "r2", title: "用户访谈", start: plusDays(todayKey, 3), end: plusDays(todayKey, 6), done: false },
      { id: "r3", title: "整理洞察", start: plusDays(todayKey, 6), end: plusDays(todayKey, 8), done: false },
    ],
  },
  {
    id: "review",
    title: "季度业务复盘",
    project: "运营",
    color: "#ec4899",
    start: plusDays(todayKey, 6),
    end: plusDays(todayKey, 11),
    notes: "汇总指标并准备管理层复盘。",
    subtasks: [
      { id: "q1", title: "汇总经营数据", start: plusDays(todayKey, 6), end: plusDays(todayKey, 8), done: false },
      { id: "q2", title: "撰写复盘材料", start: plusDays(todayKey, 8), end: plusDays(todayKey, 10), done: false },
    ],
  },
];

const initialState: AppState = {
  version: 4,
  tasks: seedTasks,
  categories: defaultCategories,
  preferences: {
    ganttMode: "body",
    zoom: "day",
    rangeMode: "fit",
    customStart: plusDays(todayKey, -3),
    customEnd: plusDays(todayKey, 30),
    fontScale: 100,
    density: "standard",
    sidebarWidth: "standard",
    detailVisible: true,
    expandedTaskIds: [],
  },
};

const normalizeTasks = (tasks: Task[]) =>
  tasks.map((task, index) => {
    const subtasks = (task.subtasks ?? []).map((sub) => ({
      ...sub,
      parentId: sub.parentId || undefined,
      completedAt: sub.done ? sub.completedAt ?? sub.end : undefined,
    }));
    const leaves = leafSubtasks(subtasks);
    const done = leaves.length > 0 && leaves.every((sub) => sub.done);
    return {
      ...task,
      showInGantt: task.showInGantt !== false,
      starred: task.starred === true,
      ganttOrder: Number.isFinite(task.ganttOrder) ? task.ganttOrder : index,
      subtasks,
      occurrenceIndex: task.occurrenceIndex ?? (task.seriesId ? 1 : undefined),
      recurrence: task.recurrence ? {
        ...task.recurrence,
        interval: Math.max(task.recurrence.interval || 1, 1),
        estimatedCount: Math.max(task.recurrence.estimatedCount || 1, 1),
        active: task.recurrence.active !== false,
      } : undefined,
      completedAt: done ? task.completedAt ?? subtasks.reduce((max, sub) => (sub.completedAt ?? sub.end) > max ? (sub.completedAt ?? sub.end) : max, task.start) : undefined,
    };
  });

function migrateState(value: unknown): AppState {
  if (Array.isArray(value)) {
    const tasks = value as Task[];
    const names = [...new Set(tasks.map((task) => task.project).filter(Boolean))];
    const extras = names
      .filter((name) => !defaultCategories.some((item) => item.name === name))
      .map((name, index) => ({ id: uid(), name, color: colors[index % colors.length] }));
    return { ...initialState, tasks: normalizeTasks(tasks), categories: [...defaultCategories, ...extras] };
  }
  if (value && typeof value === "object" && "tasks" in value) {
    const saved = value as Partial<AppState>;
    return {
      version: 4,
      tasks: Array.isArray(saved.tasks) ? normalizeTasks(saved.tasks) : seedTasks,
      categories: Array.isArray(saved.categories) && saved.categories.length ? saved.categories : defaultCategories,
      preferences: {
        ...initialState.preferences,
        ...saved.preferences,
        ganttMode:
          saved.preferences?.ganttMode === "popup" || saved.preferences?.ganttMode === "expanded"
            ? saved.preferences.ganttMode
            : "body",
      },
    };
  }
  return initialState;
}

async function loadState(): Promise<AppState> {
  try {
    const saved = await invoke<unknown>("load_app_state");
    return migrateState(saved);
  } catch {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
      return saved ? migrateState(JSON.parse(saved)) : initialState;
    } catch {
      return initialState;
    }
  }
}

async function saveState(state: AppState) {
  try {
    await invoke("save_app_state", { state });
  } catch {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

const progressOf = (task: Task) =>
  leafSubtasks(task.subtasks).length
    ? Math.round((leafSubtasks(task.subtasks).filter((item) => item.done).length / leafSubtasks(task.subtasks).length) * 100)
    : 0;

const effectiveEndOf = (task: Task) =>
  task.completedAt ?? (progressOf(task) < 100 && task.end < todayKey ? todayKey : task.end);

const effectiveSubtaskEnd = (subtask: Subtask) =>
  subtask.completedAt ?? (!subtask.done && subtask.end < todayKey ? todayKey : subtask.end);

const overdueDays = (task: Task) =>
  !task.completedAt && task.end < todayKey ? Math.max(dayDiff(task.end, todayKey), 0) : 0;

function monthTitle(date: Date) {
  return `${date.getFullYear()}年 ${date.getMonth() + 1}月`;
}

export default function App() {
  const [appState, setAppState] = useState<AppState>(initialState);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("calendar");
  const [currentMonth, setCurrentMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState(todayKey);
  const [selectedTaskId, setSelectedTaskId] = useState(seedTasks[0].id);
  const [selectedProject, setSelectedProject] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [popupTaskId, setPopupTaskId] = useState<string | null>(null);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hiddenTasksOpen, setHiddenTasksOpen] = useState(false);
  const [toast, setToast] = useState("");

  const { tasks, categories, preferences } = appState;

  useEffect(() => {
    let active = true;
    void loadState().then((saved) => {
      if (!active) return;
      setAppState(saved);
      setSelectedTaskId(saved.tasks[0]?.id ?? "");
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (ready) void saveState(appState);
  }, [appState, ready]);

  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tasks.filter(
      (task) =>
        (selectedProject === "all" || task.project === selectedProject) &&
        (!query ||
          task.title.toLowerCase().includes(query) ||
          task.project.toLowerCase().includes(query) ||
          task.notes.toLowerCase().includes(query)),
    );
  }, [tasks, selectedProject, search]);
  const ganttTasks = useMemo(
    () => filteredTasks
      .filter((task) => task.showInGantt !== false)
      .sort((a, b) => (a.ganttOrder ?? 0) - (b.ganttOrder ?? 0)),
    [filteredTasks],
  );
  const hiddenTasks = useMemo(() => tasks.filter((task) => task.showInGantt === false), [tasks]);

  const selectedTask =
    tasks.find((task) => task.id === selectedTaskId) ?? filteredTasks[0] ?? tasks[0] ?? null;
  const popupTask = tasks.find((task) => task.id === popupTaskId) ?? null;
  const completed = filteredTasks.reduce(
    (sum, task) => sum + leafSubtasks(task.subtasks).filter((item) => item.done).length,
    0,
  );
  const totalSubtasks = filteredTasks.reduce((sum, task) => sum + leafSubtasks(task.subtasks).length, 0);

  const calendarDays = useMemo(() => {
    const first = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
    const mondayOffset = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(first.getDate() - mondayOffset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, [currentMonth]);

  const updateTasks = (updater: (items: Task[]) => Task[]) =>
    setAppState((state) => ({ ...state, tasks: updater(state.tasks) }));

  const reorderGanttTasks = (sourceId: string, targetId: string, placement: "before" | "after" = "before") =>
    updateTasks((items) => {
      const ordered = [...items].sort((a, b) => (a.ganttOrder ?? 0) - (b.ganttOrder ?? 0));
      const source = ordered.findIndex((task) => task.id === sourceId);
      if (source < 0 || sourceId === targetId) return items;
      const [moved] = ordered.splice(source, 1);
      const target = ordered.findIndex((task) => task.id === targetId);
      if (target < 0) return items;
      ordered.splice(placement === "after" ? target + 1 : target, 0, moved);
      const orderById = new Map(ordered.map((task, index) => [task.id, index]));
      return items.map((task) => ({ ...task, ganttOrder: orderById.get(task.id) ?? task.ganttOrder }));
    });

  const toggleTaskStar = (taskId: string) =>
    updateTasks((items) => items.map((task) => task.id === taskId ? { ...task, starred: !task.starred } : task));

  const toggleSubtask = (taskId: string, subtaskId: string) =>
    updateTasks((items) =>
      items.map((task) => {
        if (task.id !== taskId) return task;
        const target = task.subtasks.find((sub) => sub.id === subtaskId);
        if (!target) return task;
        const nextDone = !target.done;
        const descendants = descendantsOf(task.subtasks, subtaskId);
        const subtasks = normalizeParentCompletion(task.subtasks.map((sub) =>
          sub.id === subtaskId || descendants.has(sub.id)
            ? { ...sub, done: nextDone, completedAt: nextDone ? todayKey : undefined }
            : sub,
        ));
        const leaves = leafSubtasks(subtasks);
        const done = leaves.length > 0 && leaves.every((sub) => sub.done);
        return { ...task, subtasks, completedAt: done ? task.completedAt ?? todayKey : undefined };
      }),
    );

  const setTaskCompleted = (taskId: string, completed: boolean) =>
    updateTasks((items) =>
      items.map((task) =>
        task.id === taskId
          ? {
              ...task,
              completedAt: completed ? todayKey : undefined,
              subtasks: task.subtasks.map((sub) => ({
                ...sub,
                done: completed,
                completedAt: completed ? sub.completedAt ?? todayKey : undefined,
              })),
            }
          : task,
      ),
    );

  const createCategory = (rawName: string): Category | null => {
    const name = rawName.trim();
    if (!name) return null;
    const existing = categories.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const category = { id: uid(), name, color: colors[categories.length % colors.length] };
    setAppState((state) => ({ ...state, categories: [...state.categories, category] }));
    return category;
  };

  const updateCategory = (id: string, patch: Partial<Category>) =>
    setAppState((state) => {
      const current = state.categories.find((item) => item.id === id);
      if (!current) return state;
      const nextName = patch.name?.trim() || current.name;
      const nextColor = patch.color ?? current.color;
      return {
        ...state,
        categories: state.categories.map((item) => item.id === id ? { ...item, name: nextName, color: nextColor } : item),
        tasks: state.tasks.map((task) => task.project === current.name ? { ...task, project: nextName, color: nextColor } : task),
      };
    });

  const deleteCategory = (id: string) =>
    setAppState((state) => {
      const target = state.categories.find((item) => item.id === id);
      if (!target) return state;
      let categoriesNext = state.categories.filter((item) => item.id !== id);
      let fallback = categoriesNext.find((item) => item.name === "未分类");
      if (!fallback) {
        fallback = { id: uid(), name: "未分类", color: "#94a3b8" };
        categoriesNext = [...categoriesNext, fallback];
      }
      return {
        ...state,
        categories: categoriesNext,
        tasks: state.tasks.map((task) => task.project === target.name ? { ...task, project: fallback.name, color: fallback.color } : task),
      };
    });

  const reorderCategory = (sourceId: string, targetId: string) =>
    setAppState((state) => {
      const source = state.categories.findIndex((item) => item.id === sourceId);
      const target = state.categories.findIndex((item) => item.id === targetId);
      if (source < 0 || target < 0 || source === target) return state;
      const categoriesNext = [...state.categories];
      const [moved] = categoriesNext.splice(source, 1);
      categoriesNext.splice(target, 0, moved);
      return { ...state, categories: categoriesNext };
    });

  const exportBackup = () => {
    const blob = new Blob([JSON.stringify(appState, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mori-backup-${todayKey}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importBackup = async (file: File) => {
    try {
      const restored = migrateState(JSON.parse(await file.text()));
      setAppState(restored);
      setSelectedTaskId(restored.tasks[0]?.id ?? "");
      setToast("备份已恢复");
      window.setTimeout(() => setToast(""), 2200);
    } catch {
      setToast("备份文件无法读取");
      window.setTimeout(() => setToast(""), 2200);
    }
  };

  const saveTask = (task: Task) => {
    const category = categories.find((item) => item.name === task.project);
    const normalized = { ...task, color: category?.color ?? task.color, subtasks: normalizeParentCompletion(task.subtasks) };
    const isExisting = tasks.some((item) => item.id === normalized.id);
    const newSeries = !isExisting && normalized.recurrence?.active && normalized.recurrence.estimatedCount > 1;
    const seriesId = normalized.seriesId ?? normalized.id;
    const generated = newSeries
      ? Array.from({ length: normalized.recurrence!.estimatedCount }, (_, index) =>
          cloneOccurrence({ ...normalized, seriesId }, index + 1, seriesId),
        )
      : [normalized];
    updateTasks((items) =>
      isExisting
        ? items.map((item) => (item.id === normalized.id ? normalized : item))
        : [...items, ...generated],
    );
    setSelectedTaskId(generated[0].id);
    setModalOpen(false);
    setToast("任务与偏好已保存到本机");
    window.setTimeout(() => setToast(""), 2200);
  };

  const openNew = (date = selectedDate) => {
    const defaultCategory =
      categories.find((item) => selectedProject !== "all" && item.name === selectedProject) ??
      categories[0] ??
      defaultCategories[0];
    setEditing({
      id: uid(),
      title: "",
      project: defaultCategory.name,
      color: defaultCategory.color,
      start: date,
      end: plusDays(date, 3),
      notes: "",
      showInGantt: true,
      starred: false,
      ganttOrder: tasks.length,
      subtasks: [{ id: uid(), title: "", start: date, end: plusDays(date, 1), done: false }],
    });
    setModalOpen(true);
  };

  const openCopy = (task: Task) => {
    const idMap = new Map(task.subtasks.map((sub) => [sub.id, uid()]));
    setEditing({
      ...structuredClone(task),
      id: uid(),
      title: `${task.title}（副本）`,
      completedAt: undefined,
      recurrence: undefined,
      seriesId: undefined,
      occurrenceIndex: undefined,
      copiedFromId: task.id,
      starred: false,
      ganttOrder: tasks.length,
      subtasks: task.subtasks.map((sub) => ({
        ...sub,
        id: idMap.get(sub.id)!,
        parentId: sub.parentId ? idMap.get(sub.parentId) : undefined,
        done: false,
        completedAt: undefined,
      })),
    });
    setModalOpen(true);
  };

  const extendSeries = (task: Task) => {
    if (!task.seriesId || !task.recurrence) return;
    const series = tasks.filter((item) => item.seriesId === task.seriesId);
    const nextIndex = Math.max(...series.map((item) => item.occurrenceIndex ?? 1)) + 1;
    const source = series.find((item) => item.occurrenceIndex === 1) ?? task;
    const next = cloneOccurrence({ ...source, recurrence: { ...(source.recurrence ?? task.recurrence), estimatedCount: nextIndex } }, nextIndex, task.seriesId);
    updateTasks((items) => [
      ...items.map((item) => item.seriesId === task.seriesId && item.recurrence
        ? { ...item, recurrence: { ...item.recurrence, estimatedCount: nextIndex, active: true } }
        : item),
      next,
    ]);
    setSelectedTaskId(next.id);
    setToast(`已增加第 ${nextIndex} 期`);
    window.setTimeout(() => setToast(""), 2200);
  };

  const endSeries = (task: Task) => {
    if (!task.seriesId || !window.confirm("提前结束整个循环？今天之后尚未开始的周期将移除，历史周期会保留。")) return;
    updateTasks((items) => items
      .filter((item) => item.seriesId !== task.seriesId || item.start <= todayKey || item.completedAt)
      .map((item) => item.seriesId === task.seriesId && item.recurrence
        ? { ...item, recurrence: { ...item.recurrence, active: false, endedAt: todayKey } }
        : item));
    setToast("循环任务已提前结束");
    window.setTimeout(() => setToast(""), 2200);
  };

  const openTask = (id: string) => {
    setSelectedTaskId(id);
    if (view === "gantt" && preferences.ganttMode === "popup") setPopupTaskId(id);
    if (view === "gantt" && preferences.ganttMode === "expanded") {
      updatePreferences({
        expandedTaskIds: preferences.expandedTaskIds.includes(id)
          ? preferences.expandedTaskIds.filter((taskId) => taskId !== id)
          : [...preferences.expandedTaskIds, id],
      });
    }
  };

  const setGanttMode = (ganttMode: GanttMode) =>
    setAppState((state) => ({ ...state, preferences: { ...state.preferences, ganttMode } }));

  const updatePreferences = (patch: Partial<AppState["preferences"]>) =>
    setAppState((state) => ({ ...state, preferences: { ...state.preferences, ...patch } }));

  const pageTitle =
    view === "calendar"
      ? monthTitle(currentMonth)
      : view === "gantt"
        ? "任务甘特图"
        : selectedProject === "all"
          ? "全部项目"
          : selectedProject;

  return (
    <main
      className={`app-shell density-${preferences.density} sidebar-${preferences.sidebarWidth} ${preferences.detailVisible ? "" : "detail-hidden"}`}
      style={{ "--font-scale": preferences.fontScale / 100 } as React.CSSProperties}
    >
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div><strong>Mori</strong><span>日程与任务</span></div>
        </div>
        <div className="search">
          <span>⌕</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索任务" placeholder="搜索任务、项目或备注" />
          <kbd>⌘ K</kbd>
        </div>
        <button className="settings-button" onClick={() => setSettingsOpen(true)}>显示与备份</button>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <button className="new-button" onClick={() => openNew()}><span>＋</span> 新建任务</button>
          <nav className="nav-group" aria-label="主导航">
            <button className={view === "calendar" ? "active" : ""} onClick={() => setView("calendar")}><span>▦</span> 日历</button>
            <button className={view === "gantt" ? "active" : ""} onClick={() => setView("gantt")}><span>≋</span> 甘特图</button>
            <button className={view === "tasks" ? "active" : ""} onClick={() => setView("tasks")}><span>☷</span> 我的任务 <em>{filteredTasks.length}</em></button>
          </nav>

          <div className="sidebar-section">
            <div className="section-title"><span>项目筛选</span><button onClick={() => setCategoryManagerOpen(true)} title="管理项目">＋</button></div>
            <button className={`project-link ${selectedProject === "all" ? "active" : ""}`} onClick={() => setSelectedProject("all")}>
              <i className="all-dot" /> 全部项目 <span>{tasks.length}</span>
            </button>
            {categories.map((category) => (
              <div
                className="project-filter-row"
                key={category.id}
                draggable
                onDragStart={(event) => event.dataTransfer.setData("text/category", category.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => reorderCategory(event.dataTransfer.getData("text/category"), category.id)}
              >
                <button className={`project-link ${selectedProject === category.name ? "active" : ""}`} onClick={() => setSelectedProject(category.name)}>
                  <i style={{ background: category.color }} /> {category.name}
                  <span>{tasks.filter((task) => task.project === category.name).length}</span>
                </button>
                <button className="project-edit" onClick={() => setCategoryManagerOpen(true)}>⋯</button>
              </div>
            ))}
          </div>

          <div className="storage-card">
            <div className="storage-icon">⌁</div>
            <strong>本地自动保存</strong>
            <p>任务、项目分类和甘特图显示偏好均保存在系统应用数据目录。</p>
            <div className="storage-status"><i /> 已写入本地文件</div>
          </div>
        </aside>

        <section className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">{selectedProject === "all" ? "全部工作" : `筛选 · ${selectedProject}`}</p>
              <h1>{pageTitle}</h1>
            </div>
            <div className="heading-actions">
              {view === "calendar" && (
                <>
                  <button onClick={() => setCurrentMonth((date) => new Date(date.getFullYear(), date.getMonth() - 1, 1))}>‹</button>
                  <button className="today-button" onClick={() => {
                    setCurrentMonth(new Date(today.getFullYear(), today.getMonth(), 1));
                    setSelectedDate(todayKey);
                  }}>今天</button>
                  <button onClick={() => setCurrentMonth((date) => new Date(date.getFullYear(), date.getMonth() + 1, 1))}>›</button>
                </>
              )}
              {view === "gantt" && <GanttModePicker value={preferences.ganttMode} onChange={setGanttMode} />}
              {view === "gantt" && (
                <div className="timeline-controls">
                  {(["day", "week", "month"] as const).map((zoom) => <button key={zoom} className={preferences.zoom === zoom ? "active" : ""} onClick={() => updatePreferences({ zoom })}>{zoom === "day" ? "日" : zoom === "week" ? "周" : "月"}</button>)}
                  <select value={preferences.rangeMode} onChange={(event) => updatePreferences({ rangeMode: event.target.value as AppState["preferences"]["rangeMode"] })}>
                    <option value="fit">适应任务</option><option value="month">本月</option><option value="quarter">本季度</option><option value="custom">自定义</option>
                  </select>
                  {preferences.rangeMode === "custom" && (
                    <>
                      <input type="date" aria-label="自定义开始日期" value={preferences.customStart} onChange={(event) => updatePreferences({ customStart: event.target.value })} />
                      <span>→</span>
                      <input type="date" aria-label="自定义结束日期" value={preferences.customEnd} onChange={(event) => updatePreferences({ customEnd: event.target.value })} />
                    </>
                  )}
                </div>
              )}
              {view === "gantt" && <button className="hidden-tasks-trigger" onClick={() => setHiddenTasksOpen(true)}>隐藏任务 {hiddenTasks.length ? <b>{hiddenTasks.length}</b> : null}</button>}
              <div className="view-switch">
                <button className={view === "calendar" ? "active" : ""} onClick={() => setView("calendar")}>月</button>
                <button className={view === "gantt" ? "active" : ""} onClick={() => setView("gantt")}>甘特</button>
                <button className={view === "tasks" ? "active" : ""} onClick={() => setView("tasks")}>列表</button>
              </div>
            </div>
          </div>

          <div className={`content-body ${view === "gantt" ? "gantt-content" : ""}`}>
          {view === "calendar" && (
            <CalendarView
              days={calendarDays}
              month={currentMonth}
              tasks={filteredTasks}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
              onOpenTask={openTask}
              onNew={openNew}
            />
          )}
          {view === "gantt" && (
            <>
              <MasterGantt
                tasks={ganttTasks}
                onSelect={openTask}
                selectedId={selectedTaskId}
                mode={preferences.ganttMode}
                zoom={preferences.zoom}
                rangeMode={preferences.rangeMode}
                customStart={preferences.customStart}
                customEnd={preferences.customEnd}
                expandedTaskIds={preferences.expandedTaskIds}
                onHide={(id) => updateTasks((items) => items.map((task) => task.id === id ? { ...task, showInGantt: false } : task))}
                onReorder={reorderGanttTasks}
                onToggleStar={toggleTaskStar}
              />
              {preferences.ganttMode === "body" && selectedTask && ganttTasks.some((task) => task.id === selectedTask.id) && (
                <BodyGantt task={selectedTask} onToggle={(id) => toggleSubtask(selectedTask.id, id)} />
              )}
            </>
          )}
          {view === "tasks" && (
            <ProjectTaskList
              categories={categories}
              tasks={filteredTasks}
              onSelect={openTask}
              selectedId={selectedTaskId}
            />
          )}
          </div>
        </section>

        <aside className="detail-panel">
          <div className="detail-header">
            <span>{view === "tasks" ? "任务细节" : "当前任务"}</span>
            {selectedTask && <div className="detail-actions">
              <button className={selectedTask.starred ? "starred" : ""} aria-label={selectedTask.starred ? "取消星标" : "添加星标"} title={selectedTask.starred ? "取消星标" : "添加星标"} onClick={() => toggleTaskStar(selectedTask.id)}>★</button>
              <button aria-label="复制任务" title="复制并编辑" onClick={() => openCopy(selectedTask)}>⧉</button>
              <button aria-label="编辑任务" onClick={() => { setEditing(structuredClone(selectedTask)); setModalOpen(true); }}>✎</button>
            </div>}
          </div>
          {selectedTask ? (
            <TaskDetail
              task={selectedTask}
              onToggle={(id) => toggleSubtask(selectedTask.id, id)}
              onComplete={(completed) => setTaskCompleted(selectedTask.id, completed)}
              onExtendSeries={() => extendSeries(selectedTask)}
              onEndSeries={() => endSeries(selectedTask)}
              showGantt={view !== "gantt"}
            />
          ) : (
            <div className="empty-detail">选择一个任务查看详情</div>
          )}
          <div className="progress-summary">
            <span>当前筛选完成度</span>
            <strong>{totalSubtasks ? Math.round((completed / totalSubtasks) * 100) : 0}%</strong>
            <div><i style={{ width: `${totalSubtasks ? (completed / totalSubtasks) * 100 : 0}%` }} /></div>
          </div>
        </aside>
      </div>

      {modalOpen && editing && (
        <TaskModal
          task={editing}
          categories={categories}
          onCreateCategory={createCategory}
          onClose={() => setModalOpen(false)}
          onSave={saveTask}
          onDelete={tasks.some((task) => task.id === editing.id) ? () => {
            updateTasks((items) => items.filter((item) => item.id !== editing.id));
            setModalOpen(false);
          } : undefined}
        />
      )}

      {popupTask && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPopupTaskId(null)}>
          <div className="gantt-popup">
            <div className="popup-head">
              <div><span>{popupTask.project}</span><h2>{popupTask.title}</h2></div>
              <button onClick={() => setPopupTaskId(null)}>×</button>
            </div>
            <BodyGantt task={popupTask} onToggle={(id) => toggleSubtask(popupTask.id, id)} compact />
          </div>
        </div>
      )}
      {categoryManagerOpen && (
        <CategoryManager
          categories={categories}
          taskCounts={Object.fromEntries(categories.map((category) => [category.name, tasks.filter((task) => task.project === category.name).length]))}
          onCreate={createCategory}
          onUpdate={updateCategory}
          onDelete={deleteCategory}
          onClose={() => setCategoryManagerOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          preferences={preferences}
          onChange={updatePreferences}
          onExport={exportBackup}
          onImport={importBackup}
          onClear={() => {
            if (window.confirm("确定清空全部本地任务和分类吗？建议先导出备份。")) {
              setAppState({ ...initialState, tasks: [], categories: defaultCategories });
              setSelectedTaskId("");
              setSelectedProject("all");
            }
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {hiddenTasksOpen && (
        <HiddenTasksModal
          tasks={hiddenTasks}
          onRestore={(id) => updateTasks((items) => items.map((task) => task.id === id ? { ...task, showInGantt: true } : task))}
          onRestoreAll={() => updateTasks((items) => items.map((task) => ({ ...task, showInGantt: true })))}
          onHideCompleted={() => updateTasks((items) => items.map((task) => task.completedAt ? { ...task, showInGantt: false } : task))}
          onEdit={(task) => { setEditing(structuredClone(task)); setModalOpen(true); setHiddenTasksOpen(false); }}
          onClose={() => setHiddenTasksOpen(false)}
        />
      )}
      {toast && <div className="toast">✓ {toast}</div>}
    </main>
  );
}

function GanttModePicker({ value, onChange }: { value: GanttMode; onChange: (mode: GanttMode) => void }) {
  const labels: { value: GanttMode; label: string; title: string }[] = [
    { value: "body", label: "正文", title: "在总甘特图下方展示子任务" },
    { value: "popup", label: "浮窗", title: "点击主任务后用浮窗展示" },
    { value: "expanded", label: "展开", title: "将主任务放大并在内部展示子任务" },
  ];
  return (
    <div className="mode-picker" aria-label="子任务甘特图显示方式">
      <span>子任务</span>
      {labels.map((item) => (
        <button key={item.value} title={item.title} className={value === item.value ? "active" : ""} onClick={() => onChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

function CalendarView({ days, month, tasks, selectedDate, onSelectDate, onOpenTask, onNew }: {
  days: Date[];
  month: Date;
  tasks: Task[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
  onOpenTask: (id: string) => void;
  onNew: (date: string) => void;
}) {
  return (
    <div className="calendar-card">
      <div className="weekdays">{["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((day) => <div key={day}>{day}</div>)}</div>
      <div className="calendar-grid">
        {days.map((date) => {
          const key = toDateKey(date);
          const events = tasks.filter((task) => task.start <= key && effectiveEndOf(task) >= key);
          return (
            <button
              key={key}
              className={`calendar-day ${date.getMonth() !== month.getMonth() ? "muted" : ""} ${key === todayKey ? "today" : ""} ${key === selectedDate ? "selected" : ""}`}
              onClick={() => onSelectDate(key)}
              onDoubleClick={() => onNew(key)}
            >
              <span className="day-number">{date.getDate()}</span>
              <div className="day-events">
                {events.slice(0, 3).map((event) => (
                  <span
                    key={event.id}
                    className={`event-pill ${event.start !== key ? "continued" : ""}`}
                    style={{ "--event-color": event.color } as React.CSSProperties}
                    onClick={(e) => { e.stopPropagation(); onOpenTask(event.id); }}
                  >
                    {event.start === key ? event.title : " "}
                  </span>
                ))}
                {events.length > 3 && <small>+{events.length - 3} 项</small>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TaskDetail({ task, onToggle, onComplete, onExtendSeries, onEndSeries, showGantt = true }: {
  task: Task;
  onToggle: (id: string) => void;
  onComplete: (completed: boolean) => void;
  onExtendSeries: () => void;
  onEndSeries: () => void;
  showGantt?: boolean;
}) {
  const progress = progressOf(task);
  const overdue = overdueDays(task);
  return (
    <div className="task-detail">
      <div className="task-color" style={{ background: task.color }} />
      <span className="project-badge">{task.project}</span>
      <h2>{task.title}</h2>
      <p className="task-notes">{task.notes || "还没有添加任务备注。"}</p>
      {task.seriesId && task.recurrence && (
        <div className={`series-card ${task.recurrence.active ? "" : "ended"}`}>
          <div><span>循环任务</span><strong>第 {task.occurrenceIndex ?? 1} / {task.recurrence.estimatedCount} 期</strong></div>
          <small>{task.recurrence.frequency === "daily" ? "每日" : task.recurrence.frequency === "weekly" ? "每周" : "每月"}，间隔 {task.recurrence.interval} 个周期</small>
          {task.recurrence.active && <div><button onClick={onExtendSeries}>＋ 增加一期</button><button onClick={onEndSeries}>提前结束循环</button></div>}
          {!task.recurrence.active && <em>系列已结束</em>}
        </div>
      )}
      <div className="meta-grid">
        <div><span>开始日期</span><strong>{task.start}</strong></div>
        <div><span>计划结束</span><strong>{task.end}</strong></div>
        <div><span>{task.completedAt ? "实际完成" : "当前预计结束"}</span><strong>{effectiveEndOf(task)}</strong></div>
        <div className={overdue ? "overdue-meta" : ""}><span>状态</span><strong>{task.completedAt ? "已闭环" : overdue ? `逾期 ${overdue} 天` : "进行中"}</strong></div>
      </div>
      <button className={`complete-task-button ${task.completedAt ? "reopen" : ""}`} onClick={() => onComplete(!task.completedAt)}>
        {task.completedAt ? "↺ 重新打开任务" : "✓ 完成整个任务"}
      </button>
      <div className="subtask-title"><strong>任务拆解</strong><span>{progress}%</span></div>
      <SubtaskChecklist task={task} onToggle={onToggle} />
      {showGantt && <MiniGantt task={task} />}
    </div>
  );
}

function SubtaskChecklist({ task, onToggle }: { task: Task; onToggle: (id: string) => void }) {
  return (
    <div className="subtasks">
      {task.subtasks.map((subtask) => {
        const depth = subtaskDepth(task.subtasks, subtask);
        const hasChildren = task.subtasks.some((item) => item.parentId === subtask.id);
        return (
        <button key={subtask.id} onClick={() => onToggle(subtask.id)} style={{ "--depth": depth } as React.CSSProperties}>
          {depth > 0 && <span className="tree-guide">└</span>}
          <i className={subtask.done ? "checked" : ""}>{subtask.done ? "✓" : ""}</i>
          <span><b>{subtask.title || "未命名步骤"}{hasChildren ? " ▾" : ""}</b><small>{subtask.start.slice(5)} → {subtask.end.slice(5)}</small></span>
        </button>
      )})}
      {!task.subtasks.length && <p className="empty-inline">尚未拆解子任务</p>}
    </div>
  );
}

function MiniGantt({ task, large = false }: { task: Task; large?: boolean }) {
  const naturalStart = [task.start, ...task.subtasks.map((sub) => sub.start)].reduce((min, date) => date < min ? date : min, task.start);
  const naturalEnd = [effectiveEndOf(task), ...task.subtasks.map(effectiveSubtaskEnd)].reduce((max, date) => date > max ? date : max, task.end);
  const start = naturalStart;
  const end = plusDays(naturalEnd, 3);
  const range = Math.max(dayDiff(start, end) + 1, 1);
  const scale = range <= 31 ? "day" : range <= 180 ? "week" : "month";
  const dayWidth = scale === "day" ? (large ? 28 : 18) : scale === "week" ? 9 : 4;
  const timelineWidth = Math.max(range * dayWidth, large ? 430 : 250);
  const days = Array.from({ length: range }, (_, i) => plusDays(start, i));
  const ticks = days.filter((day, index) =>
    scale === "day" ? index % (range > 18 ? 2 : 1) === 0
      : scale === "week" ? index % 7 === 0
        : new Date(`${day}T12:00:00`).getDate() === 1,
  );
  return (
    <div className={`mini-gantt ${large ? "large" : ""}`}>
      <div className="gantt-caption"><strong>子任务时间线</strong><span>{range} 天 · {scale === "day" ? "日刻度" : scale === "week" ? "周刻度" : "月刻度"}</span></div>
      <div className="mini-scroll">
        <div className="mini-timeline" style={{ "--mini-width": `${timelineWidth}px`, "--mini-day": `${dayWidth}px` } as React.CSSProperties}>
          <div className="mini-days">
            {ticks.map((day) => {
              const date = new Date(`${day}T12:00:00`);
              return <span key={day} style={{ left: `${dayDiff(start, day) * dayWidth}px` }}>{scale === "month" ? `${date.getMonth() + 1}月` : `${date.getMonth() + 1}/${date.getDate()}`}</span>;
            })}
          </div>
      {task.subtasks.map((sub) => {
        const left = Math.max(dayDiff(start, sub.start), 0);
        const width = Math.max(dayDiff(sub.start, effectiveSubtaskEnd(sub)) + 1, 1);
        const depth = subtaskDepth(task.subtasks, sub);
        return (
          <div className="mini-row" key={sub.id}>
            <span title={sub.title} style={{ paddingLeft: `${depth * 14}px` }}>{depth ? "└ " : ""}{sub.title || "未命名"}</span>
            <div className="mini-track">
              <i className={width * dayWidth < 18 ? "short-bar" : ""} style={{ background: sub.done ? "#10a37f" : task.color, left: `${left * dayWidth}px`, width: `${Math.max(width * dayWidth, 12)}px` }}>
                {large && <em>{sub.done ? "已完成" : sub.title}</em>}
              </i>
            </div>
          </div>
        );
      })}
        </div>
      </div>
    </div>
  );
}

function BodyGantt({ task, onToggle, compact = false }: { task: Task; onToggle: (id: string) => void; compact?: boolean }) {
  return (
    <section className={`body-gantt ${compact ? "compact" : ""}`}>
      <div className="body-gantt-head">
        <div><span style={{ background: task.color }} /><div><small>{task.project} · {progressOf(task)}% 完成</small><h2>{task.title}</h2></div></div>
        <p>{task.notes || "暂无任务说明"}</p>
      </div>
      <div className="body-gantt-grid">
        <SubtaskChecklist task={task} onToggle={onToggle} />
        <MiniGantt task={task} large />
      </div>
    </section>
  );
}

function MasterGantt({ tasks, onSelect, selectedId, mode, zoom, rangeMode, customStart, customEnd, expandedTaskIds, onHide, onReorder, onToggleStar }: {
  tasks: Task[];
  onSelect: (id: string) => void;
  selectedId: string;
  mode: GanttMode;
  zoom: "day" | "week" | "month";
  rangeMode: "fit" | "month" | "quarter" | "custom";
  customStart: string;
  customEnd: string;
  expandedTaskIds: string[];
  onHide: (id: string) => void;
  onReorder: (sourceId: string, targetId: string, placement?: "before" | "after") => void;
  onToggleStar: (id: string) => void;
}) {
  const ganttRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<{
    taskId: string;
    x: number;
    y: number;
    targetId?: string;
    placement?: "before" | "after";
  } | null>(null);
  const draggedTask = dragState ? tasks.find((task) => task.id === dragState.taskId) : undefined;

  useEffect(() => {
    if (!dragState) return;
    const cancelDrag = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDragState(null);
    };
    window.addEventListener("keydown", cancelDrag);
    return () => window.removeEventListener("keydown", cancelDrag);
  }, [dragState]);

  const updatePointerDrag = (event: React.PointerEvent) => {
    if (!dragState) return;
    const root = ganttRef.current;
    if (root) {
      const bounds = root.getBoundingClientRect();
      if (event.clientY < bounds.top + 42) root.scrollBy({ top: -18 });
      if (event.clientY > bounds.bottom - 42) root.scrollBy({ top: 18 });
    }
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".master-row[data-task-id]");
    if (!row || row.dataset.taskId === dragState.taskId) {
      setDragState((state) => state ? { ...state, x: event.clientX, y: event.clientY, targetId: undefined, placement: undefined } : null);
      return;
    }
    const bounds = row.getBoundingClientRect();
    setDragState((state) => state ? {
      ...state,
      x: event.clientX,
      y: event.clientY,
      targetId: row.dataset.taskId,
      placement: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    } : null);
  };

  const finishPointerDrag = () => {
    if (dragState?.targetId && dragState.placement) {
      onReorder(dragState.taskId, dragState.targetId, dragState.placement);
    }
    setDragState(null);
  };

  const keyboardReorder = (taskId: string, direction: -1 | 1) => {
    const index = tasks.findIndex((task) => task.id === taskId);
    const target = tasks[index + direction];
    if (!target) return;
    onReorder(taskId, target.id, direction < 0 ? "before" : "after");
  };

  const naturalStart = tasks.length
    ? tasks.flatMap((task) => [task.start, ...task.subtasks.map((sub) => sub.start)]).reduce((min, date) => date < min ? date : min)
    : todayKey;
  const naturalEnd = tasks.length
    ? tasks.flatMap((task) => [effectiveEndOf(task), ...task.subtasks.map(effectiveSubtaskEnd)]).reduce((max, date) => date > max ? date : max)
    : plusDays(todayKey, 4);
  const now = new Date(`${todayKey}T12:00:00`);
  const monthStart = toDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = toDateKey(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const quarterMonth = Math.floor(now.getMonth() / 3) * 3;
  const quarterStart = toDateKey(new Date(now.getFullYear(), quarterMonth, 1));
  const quarterEnd = toDateKey(new Date(now.getFullYear(), quarterMonth + 3, 0));
  const fitStart = plusDays(naturalStart, -3);
  const fitEnd = plusDays(naturalEnd, 3);
  const start = rangeMode === "month" ? monthStart : rangeMode === "quarter" ? quarterStart : rangeMode === "custom" ? customStart : fitStart;
  const rawEnd = rangeMode === "month" ? monthEnd : rangeMode === "quarter" ? quarterEnd : rangeMode === "custom" ? customEnd : fitEnd;
  const end = rawEnd < start ? start : rawEnd;
  const range = Math.max(dayDiff(start, end) + 1, 1);
  const dayWidth = zoom === "day" ? 34 : zoom === "week" ? 15 : 7;
  const timelineWidth = range * dayWidth;
  const days = Array.from({ length: range }, (_, i) => plusDays(start, i));
  const headerDays = days.filter((_, index) => zoom === "day" || (zoom === "week" ? index % 7 === 0 : new Date(`${days[index]}T12:00:00`).getDate() === 1));
  const todayLeft = dayDiff(start, todayKey) * dayWidth;
  const outsideTasks = tasks.filter((task) => task.start < start || effectiveEndOf(task) > end);
  return (
    <div
      ref={ganttRef}
      className={`master-gantt ${mode === "expanded" ? "expanded-mode" : ""} ${dragState ? "is-sorting" : ""}`}
      style={{ "--timeline-width": `${timelineWidth}px`, "--day-width": `${dayWidth}px`, "--task-count": Math.max(tasks.length, 1) } as React.CSSProperties}
      onPointerMove={updatePointerDrag}
      onPointerUp={finishPointerDrag}
      onPointerCancel={() => setDragState(null)}
    >
      <div className="gantt-table-head" style={{ width: `calc(var(--task-column-width) + ${timelineWidth}px)` }}>
        <div className="sticky-task-head">
          任务与项目
          {outsideTasks.length > 0 && <small title={outsideTasks.map((task) => task.title).join("、")}>窗口外 {outsideTasks.length}</small>}
        </div>
        <div className="gantt-head-days" style={{ width: `${timelineWidth}px` }}>
          {headerDays.map((day) => {
            const date = new Date(`${day}T12:00:00`);
            return <span key={day} style={{ left: `${dayDiff(start, day) * dayWidth}px`, width: `${zoom === "day" ? dayWidth : zoom === "week" ? dayWidth * 7 : dayWidth * 30}px` }}><b>{zoom === "month" ? `${date.getMonth() + 1}月` : `${date.getMonth() + 1}/${date.getDate()}`}</b><small>{zoom === "day" ? ["日","一","二","三","四","五","六"][date.getDay()] : zoom === "week" ? "周" : ""}</small></span>;
          })}
          {todayLeft >= 0 && todayLeft <= timelineWidth && <i className="today-line" style={{ left: `${todayLeft}px` }} />}
        </div>
      </div>
      {tasks.map((task) => {
        const taskEffectiveEnd = effectiveEndOf(task);
        const clipsLeft = task.start < start;
        const clipsRight = taskEffectiveEnd > end;
        const overlaps = task.start <= end && taskEffectiveEnd >= start;
        const visibleStart = task.start < start ? start : task.start;
        const visibleEnd = taskEffectiveEnd > end ? end : taskEffectiveEnd;
        const left = overlaps ? dayDiff(start, visibleStart) * dayWidth : taskEffectiveEnd < start ? 1 : Math.max(timelineWidth - 18, 1);
        const plannedWidth = Math.max(dayDiff(task.start, task.end) + 1, 1) * dayWidth;
        const effectiveWidth = overlaps ? Math.max(dayDiff(visibleStart, visibleEnd) + 1, 1) * dayWidth : 16;
        const progress = progressOf(task);
        const overdue = overdueDays(task);
        return (
          <div
            role="button"
            tabIndex={0}
            data-task-id={task.id}
            className={`master-row ${selectedId === task.id ? "selected" : ""} ${mode === "expanded" && expandedTaskIds.includes(task.id) ? "expanded" : ""} ${overdue ? "overdue" : ""} ${dragState?.taskId === task.id ? "dragging" : ""} ${dragState?.targetId === task.id ? `drop-${dragState.placement}` : ""}`}
            key={task.id}
            style={{ "--subtasks": task.subtasks.length, width: `calc(var(--task-column-width) + ${timelineWidth}px)` } as React.CSSProperties}
            onClick={() => onSelect(task.id)}
            onKeyDown={(event) => { if (event.key === "Enter") onSelect(task.id); }}
          >
            <div className="master-task-name">
              <button
                className="gantt-drag-handle"
                type="button"
                title="拖动排序；Alt + ↑/↓ 键盘排序"
                aria-label={`调整“${task.title}”的顺序`}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  keyboardReorder(task.id, event.key === "ArrowUp" ? -1 : 1);
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDragState({ taskId: task.id, x: event.clientX, y: event.clientY });
                }}
              >⠿</button>
              <i style={{ background: task.color }} />
              <span className="master-task-copy"><b title={task.title}>{task.title}</b><small>{task.project} · {progress}% {overdue ? `· 逾期${overdue}天` : ""}</small></span>
              <button className={`task-star ${task.starred ? "active" : ""}`} title={task.starred ? "取消星标" : "添加星标"} onClick={(event) => { event.stopPropagation(); onToggleStar(task.id); }}>★</button>
              <button className="quick-hide-task" title="从甘特图隐藏" aria-label={`隐藏“${task.title}”`} onClick={(event) => { event.stopPropagation(); onHide(task.id); }}>×</button>
            </div>
            <div className="master-track" style={{ width: `${timelineWidth}px`, backgroundSize: `${dayWidth}px 100%` }}>
              {todayLeft >= 0 && todayLeft <= timelineWidth && <i className="today-line row-line" style={{ left: `${todayLeft}px` }} />}
              <i
                title={`${task.title} · ${task.start} → ${taskEffectiveEnd}`}
                className={`main-bar ${!overlaps ? "outside-bar" : ""} ${effectiveWidth < 18 ? "short-bar" : ""}`}
                style={{ background: task.color, left: `${left}px`, width: `${Math.max(effectiveWidth, 14)}px` }}
              >
                <em style={{ width: `${progress}%` }} />
                {mode === "expanded" && expandedTaskIds.includes(task.id) && <strong>{task.title}</strong>}
              </i>
              {overlaps && effectiveWidth < 50 && <span className="short-task-label" style={{ left: `${left + Math.max(effectiveWidth, 14) + 5}px` }}>{task.title}</span>}
              {clipsLeft && <span className="range-clip left">◀ {dayDiff(task.start, start)}天</span>}
              {clipsRight && <span className="range-clip right">+{dayDiff(end, taskEffectiveEnd)}天 ▶</span>}
              {overlaps && effectiveWidth > plannedWidth && task.end >= start && <i className="extension-bar" style={{ left: `${Math.max(dayDiff(start, task.end) + 1, 0) * dayWidth}px`, width: `${Math.max(dayDiff(task.end, visibleEnd), 0) * dayWidth}px` }} />}
              {task.end >= start && task.end <= end && <i className="planned-end-mark" style={{ left: `${dayDiff(start, task.end) * dayWidth}px` }} />}
              {mode === "expanded" && expandedTaskIds.includes(task.id) && task.subtasks.map((sub, index) => {
                const subLeft = dayDiff(start, sub.start) * dayWidth;
                const subWidth = Math.max(dayDiff(sub.start, effectiveSubtaskEnd(sub)) + 1, 1) * dayWidth;
                return (
                  <span
                    key={sub.id}
                    className="embedded-subtask"
                    style={{
                      background: sub.done ? "#10a37f" : task.color,
                      left: `${subLeft}px`,
                      width: `${subWidth}px`,
                      top: `${52 + index * 24}px`,
                      paddingLeft: `${6 + subtaskDepth(task.subtasks, sub) * 10}px`,
                    }}
                  >
                    {sub.title || "未命名"}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
      {draggedTask && <div className="gantt-drag-preview" style={{ left: dragState!.x + 14, top: dragState!.y + 14 }}><i style={{ background: draggedTask.color }} />{draggedTask.title}</div>}
      {!tasks.length && <div className="gantt-empty">当前项目中还没有任务。</div>}
    </div>
  );
}

function ProjectTaskList({ categories, tasks, onSelect, selectedId }: { categories: Category[]; tasks: Task[]; onSelect: (id: string) => void; selectedId: string }) {
  const groups = categories
    .map((category) => ({ category, tasks: tasks.filter((task) => task.project === category.name) }))
    .filter((group) => group.tasks.length);
  const uncategorized = tasks.filter((task) => !categories.some((category) => category.name === task.project));
  return (
    <div className="project-list">
      {[...groups, ...(uncategorized.length ? [{ category: { id: "other", name: "其他", color: "#94a3b8" }, tasks: uncategorized }] : [])].map((group) => (
        <section className="project-group" key={group.category.id}>
          <header>
            <div><i style={{ background: group.category.color }} /><h2>{group.category.name}</h2><span>{group.tasks.length} 个任务</span></div>
            <strong>{Math.round(group.tasks.reduce((sum, task) => sum + progressOf(task), 0) / group.tasks.length)}%</strong>
          </header>
          <div className="task-list">
            {group.tasks.map((task) => (
              <button key={task.id} className={`${selectedId === task.id ? "selected" : ""} ${overdueDays(task) ? "overdue-list-item" : ""}`} onClick={() => onSelect(task.id)}>
                <i className="task-status" style={{ borderColor: task.color }}>{progressOf(task) === 100 ? "✓" : ""}</i>
                <span className="task-list-copy"><b>{task.starred ? "★ " : ""}{task.seriesId ? "↻ " : ""}{task.title}</b><small>{task.seriesId ? `循环任务 · 第 ${task.occurrenceIndex ?? 1} 期` : task.notes || "暂无说明"}</small></span>
                <span className="task-dates">{task.start.slice(5)}<b>→</b>{effectiveEndOf(task).slice(5)}{overdueDays(task) ? <small>逾期{overdueDays(task)}天</small> : null}</span>
                <span className="list-progress"><i style={{ width: `${progressOf(task)}%`, background: task.color }} /></span>
                <strong>{progressOf(task)}%</strong>
                <em>›</em>
              </button>
            ))}
          </div>
        </section>
      ))}
      {!tasks.length && <div className="empty-list"><span>☷</span><h2>这个项目还没有任务</h2><p>点击左上角“新建任务”开始规划。</p></div>}
    </div>
  );
}

function CategoryManager({ categories, taskCounts, onCreate, onUpdate, onDelete, onClose }: {
  categories: Category[];
  taskCounts: Record<string, number>;
  onCreate: (name: string) => Category | null;
  onUpdate: (id: string, patch: Partial<Category>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="category-manager">
        <div className="popup-head"><div><span>本地项目</span><h2>项目分类管理</h2></div><button onClick={onClose}>×</button></div>
        <p className="manager-hint">拖动左侧分类可调整顺序。删除含任务的分类时，任务会安全转入“未分类”。</p>
        <div className="category-create">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="输入新分类名称" onKeyDown={(event) => {
            if (event.key === "Enter") { const result = onCreate(name); if (result) setName(""); }
          }} />
          <button onClick={() => { const result = onCreate(name); if (result) setName(""); }}>＋ 新增</button>
        </div>
        <div className="category-list">
          {categories.map((category) => (
            <div key={category.id}>
              <span className="drag-handle">⠿</span>
              <input type="color" value={category.color} onChange={(event) => onUpdate(category.id, { color: event.target.value })} />
              <input value={category.name} onChange={(event) => onUpdate(category.id, { name: event.target.value })} />
              <small>{taskCounts[category.name] ?? 0} 个任务</small>
              <button onClick={() => onDelete(category.id)}>删除</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SettingsModal({ preferences, onChange, onExport, onImport, onClear, onClose }: {
  preferences: AppState["preferences"];
  onChange: (patch: Partial<AppState["preferences"]>) => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="settings-modal">
        <div className="popup-head"><div><span>个人本地工具</span><h2>显示与数据</h2></div><button onClick={onClose}>×</button></div>
        <div className="settings-grid">
          <label><span>字体大小 <b>{preferences.fontScale}%</b></span><input type="range" min="85" max="125" step="5" value={preferences.fontScale} onChange={(event) => onChange({ fontScale: Number(event.target.value) })} /></label>
          <label><span>界面密度</span><select value={preferences.density} onChange={(event) => onChange({ density: event.target.value as AppState["preferences"]["density"] })}><option value="compact">紧凑</option><option value="standard">标准</option><option value="comfortable">宽松</option></select></label>
          <label><span>左侧栏宽度</span><select value={preferences.sidebarWidth} onChange={(event) => onChange({ sidebarWidth: event.target.value as AppState["preferences"]["sidebarWidth"] })}><option value="narrow">窄</option><option value="standard">标准</option><option value="wide">宽</option></select></label>
          <label className="switch-setting"><span>显示右侧任务详情</span><input type="checkbox" checked={preferences.detailVisible} onChange={(event) => onChange({ detailVisible: event.target.checked })} /></label>
        </div>
        <div className="backup-actions">
          <div><strong>本地数据备份</strong><small>导出包含任务、分类和显示偏好的 JSON 文件。</small></div>
          <button onClick={onExport}>导出备份</button>
          <label>恢复备份<input type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onImport(file); }} /></label>
        </div>
        <div className="settings-footer"><div><button onClick={() => onChange(initialState.preferences)}>恢复默认显示</button><button className="danger-button" onClick={onClear}>清空本地数据</button></div><button className="save-button" onClick={onClose}>完成</button></div>
      </div>
    </div>
  );
}

function HiddenTasksModal({ tasks, onRestore, onRestoreAll, onHideCompleted, onEdit, onClose }: {
  tasks: Task[];
  onRestore: (id: string) => void;
  onRestoreAll: () => void;
  onHideCompleted: () => void;
  onEdit: (task: Task) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const visible = tasks.filter((task) => !query.trim() || `${task.title} ${task.project}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="hidden-tasks-modal">
        <div className="popup-head"><div><span>甘特图可见性</span><h2>隐藏的任务</h2></div><button onClick={onClose}>×</button></div>
        <div className="hidden-tools">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索隐藏任务" />
          <button onClick={onHideCompleted}>隐藏全部已完成任务</button>
          <button onClick={onRestoreAll} disabled={!tasks.length}>全部恢复</button>
        </div>
        <div className="hidden-task-list">
          {visible.map((task) => (
            <div key={task.id}>
              <i style={{ background: task.color }} />
              <button className="hidden-task-title" onClick={() => onEdit(task)}><b>{task.title}</b><small>{task.project} · {progressOf(task)}%</small></button>
              <span>{task.start.slice(5)} → {effectiveEndOf(task).slice(5)}</span>
              <button onClick={() => onRestore(task.id)}>恢复</button>
            </div>
          ))}
          {!visible.length && <div className="empty-hidden"><span>✓</span><strong>没有隐藏任务</strong><small>从甘特图隐藏的任务会集中出现在这里。</small></div>}
        </div>
      </div>
    </div>
  );
}

function TaskModal({ task, categories, onCreateCategory, onClose, onSave, onDelete }: {
  task: Task;
  categories: Category[];
  onCreateCategory: (name: string) => Category | null;
  onClose: () => void;
  onSave: (task: Task) => void;
  onDelete?: () => void;
}) {
  const [draft, setDraft] = useState(task);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [shiftChildrenWithTask, setShiftChildrenWithTask] = useState(Boolean(task.copiedFromId));
  const updateSub = (id: string, patch: Partial<Subtask>) =>
    setDraft((value) => ({ ...value, subtasks: value.subtasks.map((sub) => sub.id === id ? { ...sub, ...patch } : sub) }));
  const addChild = (parent: Subtask) => {
    const index = draft.subtasks.findIndex((sub) => sub.id === parent.id);
    const child = { id: uid(), parentId: parent.id, title: "", start: parent.start, end: parent.end, done: false };
    const subtasks = [...draft.subtasks];
    subtasks.splice(index + 1, 0, child);
    setDraft({ ...draft, subtasks });
  };
  const changeDepth = (subtask: Subtask, direction: "in" | "out") => {
    if (direction === "out") {
      const parent = draft.subtasks.find((item) => item.id === subtask.parentId);
      updateSub(subtask.id, { parentId: parent?.parentId });
      return;
    }
    const index = draft.subtasks.findIndex((item) => item.id === subtask.id);
    const previous = [...draft.subtasks.slice(0, index)].reverse().find((item) => item.parentId === subtask.parentId);
    if (previous && subtaskDepth(draft.subtasks, previous) < 3) updateSub(subtask.id, { parentId: previous.id });
  };
  const addCategory = () => {
    const category = onCreateCategory(newCategory);
    if (!category) return;
    setDraft((value) => ({ ...value, project: category.name, color: category.color }));
    setNewCategory("");
    setCreatingCategory(false);
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim()) return;
    onSave({ ...draft, title: draft.title.trim(), end: draft.end < draft.start ? draft.start : draft.end });
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="task-modal" onSubmit={submit}>
        <div className="modal-header">
          <div><span>{onDelete ? "编辑任务" : "新建任务"}</span><h2>把目标变成清晰的行动</h2></div>
          <button type="button" onClick={onClose}>×</button>
        </div>
        <label className="title-field">
          <span>任务名称</span>
          <input autoFocus required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="例如：准备秋季新品发布" />
        </label>
        <div className="form-row">
          <label>
            <span>项目分类</span>
            <select value={creatingCategory ? "__new__" : draft.project} onChange={(event) => {
              if (event.target.value === "__new__") {
                setCreatingCategory(true);
              } else {
                const category = categories.find((item) => item.name === event.target.value);
                setCreatingCategory(false);
                setDraft({ ...draft, project: event.target.value, color: category?.color ?? draft.color });
              }
            }}>
              {categories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}
              <option value="__new__">＋ 新建分类…</option>
            </select>
          </label>
          <label><span>开始</span><input type="date" value={draft.start} onChange={(e) => {
            const nextStart = e.target.value;
            const offset = dayDiff(draft.start, nextStart);
            setDraft({
              ...draft,
              start: nextStart,
              end: shiftChildrenWithTask ? plusDays(draft.end, offset) : draft.end,
              subtasks: shiftChildrenWithTask ? draft.subtasks.map((sub) => ({ ...sub, start: plusDays(sub.start, offset), end: plusDays(sub.end, offset) })) : draft.subtasks,
            });
          }} /></label>
          <label><span>结束</span><input type="date" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} /></label>
        </div>
        {creatingCategory && (
          <div className="new-category-row">
            <input value={newCategory} onChange={(event) => setNewCategory(event.target.value)} placeholder="输入新的分类名称" onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); addCategory(); }
            }} />
            <button type="button" onClick={addCategory}>添加分类</button>
          </div>
        )}
        <label>
          <span>备注</span>
          <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="写下背景、目标或完成标准…" />
        </label>
        {task.copiedFromId && (
          <label className="shift-copy-setting">
            <input type="checkbox" checked={shiftChildrenWithTask} onChange={(event) => setShiftChildrenWithTask(event.target.checked)} />
            <span><b>修改开始日期时整体平移</b><small>主任务、结束日期和所有嵌套子任务一起移动</small></span>
          </label>
        )}
        <div className="recurrence-editor">
          <div className="breakdown-head">
            <div><span>定时循环</span><small>按预计周期生成可独立完成的任务</small></div>
            <label className="switch-inline"><input type="checkbox" checked={Boolean(draft.recurrence)} onChange={(event) => setDraft({
              ...draft,
              recurrence: event.target.checked ? { frequency: "weekly", interval: 1, estimatedCount: 4, active: true } : undefined,
            })} /> 启用</label>
          </div>
          {draft.recurrence && (
            <div className="recurrence-fields">
              <label><span>频率</span><select value={draft.recurrence.frequency} onChange={(event) => setDraft({ ...draft, recurrence: { ...draft.recurrence!, frequency: event.target.value as RecurrenceRule["frequency"] } })}><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select></label>
              <label><span>间隔</span><input type="number" min="1" max="99" value={draft.recurrence.interval} onChange={(event) => setDraft({ ...draft, recurrence: { ...draft.recurrence!, interval: Math.max(Number(event.target.value), 1) } })} /></label>
              <label><span>预估周期数</span><input type="number" min="1" max="365" value={draft.recurrence.estimatedCount} onChange={(event) => setDraft({ ...draft, recurrence: { ...draft.recurrence!, estimatedCount: Math.max(Number(event.target.value), 1) } })} /></label>
            </div>
          )}
        </div>
        <div className="color-picker"><span>任务颜色</span>{colors.map((color) => <button type="button" key={color} className={draft.color === color ? "selected" : ""} style={{ background: color }} onClick={() => setDraft({ ...draft, color })} />)}</div>
        <label className="gantt-visibility-setting">
          <span><b>在任务甘特图中显示</b><small>关闭后任务仍保留在日历、项目列表和搜索中</small></span>
          <input type="checkbox" checked={draft.showInGantt !== false} onChange={(event) => setDraft({ ...draft, showInGantt: event.target.checked })} />
        </label>
        <div className="breakdown-head">
          <div><span>任务拆解</span><small>每一步都会显示在任务内甘特图中</small></div>
          <button type="button" onClick={() => setDraft({ ...draft, subtasks: [...draft.subtasks, { id: uid(), title: "", start: draft.start, end: draft.end, done: false }] })}>＋ 添加步骤</button>
        </div>
        <div className="subtask-editor">
          {draft.subtasks.map((sub, index) => (
            <div className="subtask-edit-row" key={sub.id} style={{ "--depth": subtaskDepth(draft.subtasks, sub) } as React.CSSProperties}>
              <span className="step-number">{pad(index + 1)}</span>
              <input aria-label={`步骤 ${index + 1} 名称`} value={sub.title} onChange={(e) => updateSub(sub.id, { title: e.target.value })} placeholder="填写具体行动" />
              <input aria-label="开始日期" type="date" value={sub.start} onChange={(e) => updateSub(sub.id, { start: e.target.value })} />
              <span>→</span>
              <input aria-label="结束日期" type="date" value={sub.end} onChange={(e) => updateSub(sub.id, { end: e.target.value })} />
              <div className="subtask-row-actions">
                <button type="button" title="添加下级" onClick={() => addChild(sub)}>＋</button>
                <button type="button" title="降级" disabled={index === 0 || subtaskDepth(draft.subtasks, sub) >= 3} onClick={() => changeDepth(sub, "in")}>→</button>
                <button type="button" title="升级" disabled={!sub.parentId} onClick={() => changeDepth(sub, "out")}>←</button>
                <button type="button" aria-label="删除步骤" onClick={() => {
                  const descendants = descendantsOf(draft.subtasks, sub.id);
                  setDraft({ ...draft, subtasks: draft.subtasks.filter((item) => item.id !== sub.id && !descendants.has(item.id)) });
                }}>×</button>
              </div>
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <div>{onDelete && <button type="button" className="delete-button" onClick={onDelete}>删除任务</button>}</div>
          <div><button type="button" onClick={onClose}>取消</button><button className="save-button">保存任务</button></div>
        </div>
      </form>
    </div>
  );
}
