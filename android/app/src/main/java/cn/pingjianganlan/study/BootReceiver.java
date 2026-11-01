package cn.pingjianganlan.study;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

/**
 * Re-arms the daily alarm after reboot, an app update, or a system clock/timezone/
 * date change. Cancelling the shared PendingIntent before scheduling keeps repeated
 * broadcasts from stacking duplicate alarms.
 */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !isRearmAction(intent.getAction())) {
            return;
        }
        rearmInBackground(context, goAsync());
    }

    /**
     * Shared by the boot/time-change receiver and the exact-alarm permission receiver.
     * The caller already obtained a goAsync result; work stays off the broadcast thread.
     */
    static void rearmInBackground(Context context,
                                  BroadcastReceiver.PendingResult pendingResult) {
        final Context appContext = context.getApplicationContext();
        Thread worker = new Thread(() -> {
            try {
                ReminderScheduler.ensureChannel(appContext);
                NativeStore store = new NativeStore(appContext);
                JSONObject config = store.getReminder();
                if (config.optBoolean("enabled", false)) {
                    ReminderScheduler.schedule(appContext, config.optString("time", "20:30"));
                } else {
                    ReminderScheduler.cancel(appContext);
                }
            } catch (UserException | RuntimeException ignored) {
                // No user-facing surface exists in a boot/time-change receiver.
            } finally {
                pendingResult.finish();
            }
        }, "reminder-rearm");
        worker.setDaemon(true);
        worker.start();
    }

    /**
     * Package-visible contract for tests. TIME_SET is the platform value for
     * {@link Intent#ACTION_TIME_CHANGED}; all five actions are declared in the
     * manifest receiver filter.
     */
    static boolean isRearmAction(String action) {
        return Intent.ACTION_BOOT_COMPLETED.equals(action)
            || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
            || Intent.ACTION_TIME_CHANGED.equals(action)
            || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
            || Intent.ACTION_DATE_CHANGED.equals(action);
    }
}
