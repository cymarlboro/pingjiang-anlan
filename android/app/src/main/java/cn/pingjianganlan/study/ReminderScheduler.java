package cn.pingjianganlan.study;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import java.util.Calendar;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Daily reminders use an exact alarm when Android 12+ allows it, and otherwise fall
 * back to an inexact while-idle alarm. The receiver re-arms the following local day.
 * The same PendingIntent is always cancelled before it is scheduled again, so a
 * re-arm replaces the existing alarm instead of creating a duplicate.
 */
public final class ReminderScheduler {
    public static final String CHANNEL_ID = "daily_review";
    public static final String DAILY_REMINDER_ACTION = "cn.pingjianganlan.study.DAILY_REMINDER";
    public static final int ALARM_REQUEST_CODE = 4101;
    public static final int NOTIFICATION_ID = 4102;

    private static final Object ALARM_LOCK = new Object();

    /** How the next daily alarm will be delivered. */
    public enum ScheduleMode {
        EXACT,
        INEXACT
    }

    private ReminderScheduler() {
    }

    public static void ensureChannel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription(context.getString(R.string.notification_channel_description));
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
    }

    public static boolean permissionGranted(Context context) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context,
            Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    public static boolean channelEnabled(Context context) {
        ensureChannel(context);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) {
            return false;
        }
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        return channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    /**
     * True on Android 12+ when the user has allowed exact alarms, and always true on
     * older releases where exact alarms need no special access.
     */
    public static boolean canScheduleExactAlarms(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        AlarmManager manager = context.getSystemService(AlarmManager.class);
        return manager != null && manager.canScheduleExactAlarms();
    }

    /** True only when Android 12+ is withholding the exact-alarm permission. */
    public static boolean exactAlarmPermissionRequired(Context context) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !canScheduleExactAlarms(context);
    }

    public static ScheduleMode scheduleMode(Context context) {
        return decideScheduleMode(Build.VERSION.SDK_INT, canScheduleExactAlarms(context));
    }

    /**
     * Pure decision used by scheduling and by the unit tests. Exact alarms are used
     * on releases before Android 12, and on Android 12+ only when the user has
     * granted the exact-alarm permission; otherwise scheduling stays inexact.
     */
    static ScheduleMode decideScheduleMode(int sdkInt, boolean canScheduleExactAlarms) {
        if (sdkInt < 31) {
            return ScheduleMode.EXACT;
        }
        return canScheduleExactAlarms ? ScheduleMode.EXACT : ScheduleMode.INEXACT;
    }

    public static void schedule(Context context, String time) throws UserException {
        if (!TextRules.isValidReminderTime(time)) {
            throw new UserException("提醒时间格式应为 HH:mm");
        }
        AlarmManager manager = context.getSystemService(AlarmManager.class);
        if (manager == null) {
            throw new UserException("系统闹钟服务不可用");
        }
        PendingIntent pendingIntent = alarmIntent(context);
        long triggerAt = nextTriggerMillis(time);
        boolean exact = decideScheduleMode(Build.VERSION.SDK_INT,
            canScheduleExactAlarms(context)) == ScheduleMode.EXACT;
        synchronized (ALARM_LOCK) {
            try {
                manager.cancel(pendingIntent);
                if (exact) {
                    manager.setExactAndAllowWhileIdle(
                        AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
                } else {
                    manager.setAndAllowWhileIdle(
                        AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
                }
            } catch (SecurityException exception) {
                if (exact) {
                    // Permission can be revoked between the check and this call. Keep a
                    // reminder rather than losing it, but it is now openly inexact.
                    try {
                        manager.cancel(pendingIntent);
                        manager.setAndAllowWhileIdle(
                            AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
                        return;
                    } catch (SecurityException fallbackException) {
                        throw new UserException("系统未允许设置提醒", fallbackException);
                    }
                }
                throw new UserException("系统未允许设置提醒", exception);
            }
        }
    }

    public static void cancel(Context context) {
        AlarmManager manager = context.getSystemService(AlarmManager.class);
        if (manager != null) {
            synchronized (ALARM_LOCK) {
                manager.cancel(alarmIntent(context));
            }
        }
    }

    /** Next local occurrence of {@code time}; today if still ahead, otherwise tomorrow. */
    public static long nextTriggerMillis(String time) throws UserException {
        return nextTriggerMillis(time, System.currentTimeMillis(), TimeZone.getDefault());
    }

    /**
     * Package-visible clock/timezone seam so the local-Calendar behaviour is covered
     * by JVM unit tests without depending on the device clock.
     */
    static long nextTriggerMillis(String time, long nowMillis, TimeZone timeZone)
        throws UserException {
        if (!TextRules.isValidReminderTime(time)) {
            throw new UserException("提醒时间格式应为 HH:mm");
        }
        int hour = Integer.parseInt(time.substring(0, 2));
        int minute = Integer.parseInt(time.substring(3, 5));
        Calendar calendar = Calendar.getInstance(timeZone, Locale.getDefault());
        calendar.setTimeInMillis(nowMillis);
        calendar.set(Calendar.HOUR_OF_DAY, hour);
        calendar.set(Calendar.MINUTE, minute);
        calendar.set(Calendar.SECOND, 0);
        calendar.set(Calendar.MILLISECOND, 0);
        if (calendar.getTimeInMillis() <= nowMillis) {
            calendar.add(Calendar.DAY_OF_YEAR, 1);
        }
        return calendar.getTimeInMillis();
    }

    public static boolean showNotification(Context context) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context,
            Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        if (!permissionGranted(context) || !channelEnabled(context)) {
            return false;
        }
        ensureChannel(context);
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            context,
            NOTIFICATION_ID,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_review)
            .setContentTitle(context.getString(R.string.notification_title))
            .setContentText(context.getString(R.string.notification_text))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build());
            return true;
        } catch (SecurityException exception) {
            return false;
        }
    }

    private static PendingIntent alarmIntent(Context context) {
        Intent intent = new Intent(context, ReminderReceiver.class);
        intent.setAction(DAILY_REMINDER_ACTION);
        return PendingIntent.getBroadcast(
            context,
            ALARM_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
