import * as api from "../api";
import { useSettings } from "../app";
import { Section } from "./Section";

function formatTimeRemaining(scheduledFor: string): string {
  const scheduledDate = new Date(scheduledFor);
  const now = new Date();
  const minutesRemaining = Math.max(
    0,
    Math.round((scheduledDate.getTime() - now.getTime()) / (1000 * 60))
  );
  if (minutesRemaining === 0) return "Due now";
  if (minutesRemaining < 60) return `in ${minutesRemaining} min`;
  const hours = Math.floor(minutesRemaining / 60);
  const mins = minutesRemaining % 60;
  return `in ${hours}h ${mins}m`;
}

function truncateText(text: string, maxLength: number): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

export function RemindersSection({ adminOnly }: { adminOnly?: boolean }) {
  const ctx = useSettings();

  async function handleCancel(scheduleId: string) {
    if (!ctx.canEditSection("schedules")) return;
    if (!confirm("Cancel this scheduled reminder?")) return;
    ctx.schedulesLoading.value = true;
    try {
      await api.cancelSchedule(ctx.agentId, scheduleId);
      ctx.schedules.value = ctx.schedules.value.filter(
        (s) => s.scheduleId !== scheduleId
      );
      ctx.successMsg.value = "Reminder cancelled!";
    } catch (e: unknown) {
      ctx.schedulesError.value = e instanceof Error ? e.message : "Failed";
      setTimeout(() => {
        ctx.schedulesError.value = "";
      }, 5000);
    } finally {
      ctx.schedulesLoading.value = false;
    }
  }

  const loadingBadge = ctx.schedulesLoading.value ? (
    <span class="animate-spin text-slate-600">&#8635;</span>
  ) : undefined;

  return (
    <Section
      id="schedules"
      title="Schedules"
      icon="&#9200;"
      sectionKey="schedules"
      badge={loadingBadge}
      adminOnly={adminOnly}
    >
      <div>
        {ctx.schedulesError.value && (
          <div class="bg-red-100 text-red-800 px-3 py-2 rounded-lg text-xs mb-2">
            {ctx.schedulesError.value}
          </div>
        )}
        <div class="space-y-2">
          {ctx.schedules.value.length === 0 && (
            <p class="text-xs text-gray-500">No schedules.</p>
          )}
          {ctx.schedules.value.map((schedule) => (
            <div
              key={schedule.scheduleId}
              class="flex items-start justify-between p-2 bg-white rounded border border-gray-200"
            >
              <div class="flex-1 min-w-0">
                <p
                  class="text-xs font-medium text-gray-800 truncate"
                  title={schedule.task}
                >
                  {truncateText(schedule.task, 60)}
                </p>
                <p class="text-xs text-gray-500">
                  <span
                    class={`inline-block px-1.5 py-0.5 rounded text-xs ${
                      schedule.status === "pending"
                        ? "bg-slate-100 text-slate-800"
                        : schedule.status === "triggered"
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {schedule.status}
                  </span>
                  {schedule.isRecurring && schedule.cron && (
                    <span
                      class="inline-block px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-800 ml-1"
                      title={`Cron: ${schedule.cron}`}
                    >
                      &#128260; {schedule.iteration}/{schedule.maxIterations}
                    </span>
                  )}
                  <span
                    class="ml-1"
                    title={new Date(schedule.scheduledFor).toLocaleString()}
                  >
                    {formatTimeRemaining(schedule.scheduledFor)}
                  </span>
                  {schedule.isRecurring && schedule.cron && (
                    <span class="text-gray-400 ml-1">({schedule.cron})</span>
                  )}
                </p>
              </div>
              {schedule.status === "pending" && (
                <button
                  type="button"
                  disabled={!ctx.canEditSection("schedules")}
                  onClick={() => handleCancel(schedule.scheduleId)}
                  class="ml-2 px-2 py-1 text-xs rounded bg-red-100 text-red-700 hover:bg-red-200 flex-shrink-0 disabled:opacity-50"
                >
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
        <div class="mt-3 pt-3 border-t border-gray-200">
          <p class="text-xs font-medium text-gray-600 mb-1">Example prompts:</p>
          <p class="text-xs text-gray-500 mb-1 font-medium">One-time:</p>
          <ul class="text-xs text-gray-500 space-y-1 mb-2">
            <li>&bull; "Remind me in 30 minutes to check the build status"</li>
            <li>
              &bull; "Set a reminder for 2 hours from now to review the PR"
            </li>
          </ul>
          <p class="text-xs text-gray-500 mb-1 font-medium">Recurring:</p>
          <ul class="text-xs text-gray-500 space-y-1">
            <li>
              &bull; "Check the API status every 30 minutes for the next 2
              hours"
            </li>
            <li>
              &bull; "Poll the deployment health every hour until it succeeds
              (max 12 checks)"
            </li>
            <li>
              &bull; "Send me a morning standup reminder at 9am on weekdays"
            </li>
          </ul>
          <p class="text-xs text-gray-400 mt-2">
            One-time: max 24 hours. Recurring: min 5 min interval, max 100
            iterations.
          </p>
        </div>
      </div>
    </Section>
  );
}
