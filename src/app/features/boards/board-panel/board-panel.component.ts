import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import { PlannerTaskComponent } from '../../planner/planner-task/planner-task.component';
import {
  BoardPanelCfg,
  BoardPanelCfgScheduledState,
  BoardPanelCfgTaskDoneState,
  BoardPanelCfgTaskTypeFilter,
} from '../boards.model';
import { select, Store } from '@ngrx/store';
import {
  selectAllTasksWithoutHiddenProjects,
  selectTaskById,
  selectTaskByIdWithSubTaskData,
} from '../../tasks/store/task.selectors';
import { toSignal } from '@angular/core/rxjs-interop';
import { AddTaskInlineComponent } from '../../planner/add-task-inline/add-task-inline.component';
import { T } from '../../../t.const';
import { TaskCopy } from '../../tasks/task.model';
import { TaskService } from '../../tasks/task.service';
import { BoardsActions } from '../store/boards.actions';
import { moveItemInArray } from '../../../util/move-item-in-array';
import { unique } from '../../../util/unique';
import { TaskSharedActions } from '../../../root-store/meta/task-shared.actions';
import { LocalDateStrPipe } from '../../../ui/pipes/local-date-str.pipe';
import { MatIcon } from '@angular/material/icon';
import { MatIconButton } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { DialogScheduleTaskComponent } from '../../planner/dialog-schedule-task/dialog-schedule-task.component';
import { MatDialog } from '@angular/material/dialog';
import { fastArrayCompare } from '../../../util/fast-array-compare';
import { first, take } from 'rxjs/operators';
import { ShortPlannedAtPipe } from '../../../ui/pipes/short-planned-at.pipe';
import { MsToStringPipe } from '../../../ui/duration/ms-to-string.pipe';
import { selectUnarchivedVisibleProjects } from '../../project/store/project.selectors';

@Component({
  selector: 'board-panel',
  standalone: true,
  imports: [
    CdkDrag,
    PlannerTaskComponent,
    CdkDropList,
    AddTaskInlineComponent,
    LocalDateStrPipe,
    MatIcon,
    MatIconButton,
    TranslatePipe,
    ShortPlannedAtPipe,
    MsToStringPipe,
  ],
  templateUrl: './board-panel.component.html',
  styleUrl: './board-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardPanelComponent {
  T = T;

  panelCfg = input.required<BoardPanelCfg>();
  editBoard = output<void>();

  store = inject(Store);
  taskService = inject(TaskService);
  _matDialog = inject(MatDialog);

  allTasks$ = this.store.select(selectAllTasksWithoutHiddenProjects);
  allTasks = toSignal(this.allTasks$, {
    initialValue: [],
  });

  allProjects$ = this.store.select(selectUnarchivedVisibleProjects);
  allProjects = toSignal(this.allProjects$, {
    initialValue: [],
  });

  // Create a Set of all backlog task IDs for fast lookup
  allBacklogTaskIds = computed(() => {
    const backlogIds = new Set<string>();
    for (const project of this.allProjects()) {
      if (project && project.backlogTaskIds && Array.isArray(project.backlogTaskIds)) {
        project.backlogTaskIds.forEach((id) => backlogIds.add(id));
      }
    }
    return backlogIds;
  });

  totalEstimate = computed(() =>
    this.tasks().reduce((acc, task) => acc + (task.timeEstimate || 0), 0),
  );

  additionalTaskFields = computed(() => {
    const panelCfg = this.panelCfg();

    return {
      ...(panelCfg.includedTagIds ? { tagIds: panelCfg.includedTagIds } : {}),
      // ...(panelCfg.projectId ? { projectId: panelCfg.projectId } : {}),
      ...(panelCfg.taskDoneState === BoardPanelCfgTaskDoneState.Done
        ? { isDone: true }
        : {}),
      ...(panelCfg.taskDoneState === BoardPanelCfgTaskDoneState.UnDone
        ? { isDone: false }
        : {}),
      ...(panelCfg.projectId && panelCfg.projectId.length
        ? { projectId: panelCfg.projectId }
        : {}),
      // TODO scheduledState
    };
  });

  tasks = computed(() => {
    const panelCfg = this.panelCfg();
    const orderedTasks: TaskCopy[] = [];
    const nonOrderedTasks: TaskCopy[] = [];

    const allFilteredTasks = this.allTasks().filter((task) => {
      let isTaskIncluded = true;
      if (panelCfg.includedTagIds?.length) {
        isTaskIncluded = panelCfg.includedTagIds.every((tagId) =>
          task.tagIds.includes(tagId),
        );
      }
      if (panelCfg.excludedTagIds?.length) {
        isTaskIncluded =
          isTaskIncluded &&
          !panelCfg.excludedTagIds.some((tagId) => task.tagIds.includes(tagId));
      }

      if (panelCfg.isParentTasksOnly) {
        isTaskIncluded = isTaskIncluded && !task.parentId;
      }

      if (panelCfg.taskDoneState === BoardPanelCfgTaskDoneState.Done) {
        isTaskIncluded = isTaskIncluded && task.isDone;
      }

      if (panelCfg.taskDoneState === BoardPanelCfgTaskDoneState.UnDone) {
        isTaskIncluded = isTaskIncluded && !task.isDone;
      }

      if (panelCfg.projectId) {
        // TODO check parentId case thoroughly
        isTaskIncluded = isTaskIncluded && task.projectId === panelCfg.projectId;
      }

      if (panelCfg.scheduledState === BoardPanelCfgScheduledState.Scheduled) {
        isTaskIncluded = isTaskIncluded && !!(task.dueWithTime || task.dueDay);
      }

      if (panelCfg.scheduledState === BoardPanelCfgScheduledState.NotScheduled) {
        isTaskIncluded = isTaskIncluded && !task.dueWithTime && !task.dueDay;
      }

      if (panelCfg.backlogState === BoardPanelCfgTaskTypeFilter.OnlyBacklog) {
        isTaskIncluded = isTaskIncluded && this._isTaskInBacklog(task);
      }

      if (panelCfg.backlogState === BoardPanelCfgTaskTypeFilter.NoBacklog) {
        isTaskIncluded = isTaskIncluded && !this._isTaskInBacklog(task);
      }

      return isTaskIncluded;
    });

    allFilteredTasks.forEach((task) => {
      const index = panelCfg.taskIds.indexOf(task.id);
      if (index > -1) {
        orderedTasks[index] = task;
      } else {
        nonOrderedTasks.push(task);
      }
    });
    return [...orderedTasks, ...nonOrderedTasks].filter((t) => !!t);
  });

  async drop(ev: CdkDragDrop<BoardPanelCfg, string, TaskCopy>): Promise<void> {
    const panelCfg = ev.container.data;
    const task = ev.item.data;
    const prevTaskIds = this.tasks().map((t) => t.id);

    const taskIds = prevTaskIds.includes(task.id)
      ? // move in array
        moveItemInArray(prevTaskIds, ev.previousIndex, ev.currentIndex)
      : // NOTE: original array is mutated and splice does not return a new array
        prevTaskIds.splice(ev.currentIndex, 0, task.id) && prevTaskIds;

    let newTagIds: string[] = task.tagIds;
    if (panelCfg.includedTagIds?.length) {
      newTagIds = newTagIds.concat(panelCfg.includedTagIds);
    }
    if (panelCfg.excludedTagIds?.length) {
      newTagIds = newTagIds.filter((tagId) => !panelCfg.excludedTagIds!.includes(tagId));
    }

    const updates: Partial<TaskCopy> = {};

    // conditional updates
    if (!fastArrayCompare(task.tagIds, newTagIds)) {
      this.taskService.updateTags(task, unique(newTagIds));
    }
    if (panelCfg.taskDoneState === BoardPanelCfgTaskDoneState.Done && !task.isDone) {
      updates.isDone = true;
    } else if (
      panelCfg.taskDoneState === BoardPanelCfgTaskDoneState.UnDone &&
      task.isDone
    ) {
      updates.isDone = false;
    }

    if (panelCfg.projectId?.length && task.projectId !== panelCfg.projectId) {
      const taskWithSubTasks = await this.store
        .pipe(
          select(selectTaskByIdWithSubTaskData, { id: task.parentId || task.id }),
          take(1),
        )
        .toPromise();

      this.store.dispatch(
        TaskSharedActions.moveToOtherProject({
          task: taskWithSubTasks,
          targetProjectId: panelCfg.projectId,
        }),
      );
    }

    if (Object.keys(updates).length > 0) {
      this.store.dispatch(
        TaskSharedActions.updateTask({ task: { id: task.id, changes: updates } }),
      );
    }

    this.store.dispatch(
      BoardsActions.updatePanelCfgTaskIds({
        panelId: panelCfg.id,
        taskIds,
      }),
    );

    this._checkToScheduledTask(panelCfg, task.id);
  }

  async afterTaskAdd({
    taskId,
    isAddToBottom,
  }: {
    taskId: string;
    isAddToBottom: boolean;
  }): Promise<void> {
    const panelCfg = this.panelCfg();
    this.store.dispatch(
      BoardsActions.updatePanelCfgTaskIds({
        panelId: panelCfg.id,
        taskIds: isAddToBottom
          ? [...panelCfg.taskIds, taskId]
          : [taskId, ...panelCfg.taskIds],
      }),
    );

    this._checkToScheduledTask(panelCfg, taskId);
  }

  scheduleTask(task: TaskCopy, ev?: MouseEvent): void {
    ev?.preventDefault();
    ev?.stopPropagation();
    this._matDialog.open(DialogScheduleTaskComponent, {
      restoreFocus: true,
      data: { task },
    });
  }

  private async _checkToScheduledTask(
    panelCfg: BoardPanelCfg,
    taskId: string,
  ): Promise<void> {
    if (panelCfg.scheduledState === BoardPanelCfgScheduledState.Scheduled) {
      const task = await this.store
        .select(selectTaskById, { id: taskId })
        .pipe(first())
        .toPromise();
      if (!task.dueDay && !task.dueWithTime) {
        this.scheduleTask(task);
      }
    }
    if (panelCfg.scheduledState === BoardPanelCfgScheduledState.NotScheduled) {
      const task = await this.store
        .select(selectTaskById, { id: taskId })
        .pipe(first())
        .toPromise();

      this.store.dispatch(
        TaskSharedActions.unscheduleTask({
          id: taskId,
          reminderId: task.reminderId,
          isSkipToast: false,
        }),
      );
    }
  }

  _isTaskInBacklog(task: Readonly<TaskCopy>): boolean {
    return this.allBacklogTaskIds().has(task.id);
  }
}
