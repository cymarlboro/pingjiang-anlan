package cn.pingjianganlan.study;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

/**
 * Delivers the daily reminder, then always re-arms the next local day. File access
 * runs on a short-lived worker so the broadcast thread is not used for disk I/O.
 */
public final class ReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        final PendingResult pendingResult = goAsync();
        final Context appContext = context.getApplicationContext();
        Thread worker = new Thread(() -> {
            try {
                NativeStore store = new NativeStore(appContext);
                JSONObject config = store.getReminder();
                boolean enabled = config.optBoolean("enabled", false);
                String time = config.optString("time", "20:30");
                if (enabled) {
                    ReminderScheduler.showNotification(appContext);
                    try {
                        ReminderScheduler.schedule(appContext, time);
                    } catch (UserException ignored) {
                        ReminderScheduler.cancel(appContext);
                    }
                } else {
                    ReminderScheduler.cancel(appContext);
                }
            } catch (RuntimeException ignored) {
                // A corrupt store must not crash the broadcast; the app can recover
                // through a backup import.
            } finally {
                pendingResult.finish();
            }
        }, "daily-reminder");
        worker.setDaemon(true);
        worker.start();
    }
}
