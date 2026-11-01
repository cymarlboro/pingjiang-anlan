package cn.pingjianganlan.study;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Android 12+ sends this protected system broadcast when the user grants exact-alarm
 * access. Re-arming here replaces the inexact fallback with an exact daily alarm without
 * waiting for the user to revisit the reminder settings.
 */
public final class ExactAlarmPermissionReceiver extends BroadcastReceiver {
    /**
     * Platform value of {@link AlarmManager#ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED}.
     * Kept as a literal so the manifest contract can be checked in a plain JVM test.
     */
    public static final String ACTION =
        "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return;
        }
        if (intent == null || !ACTION.equals(intent.getAction())) {
            return;
        }
        BootReceiver.rearmInBackground(context, goAsync());
    }
}
