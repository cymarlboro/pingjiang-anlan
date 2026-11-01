package cn.pingjianganlan.study;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import java.io.File;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.TimeZone;

import javax.xml.parsers.DocumentBuilderFactory;

/** JVM tests for reminder timing, exact-alarm selection, and manifest wiring. */
public class ReminderSchedulerTest {
    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";
    private static final TimeZone SHANGHAI = TimeZone.getTimeZone("Asia/Shanghai");

    @Test
    public void nextTriggerUsesLocalClockAndRollsForward() throws Exception {
        long now = at(ZoneId.of("Asia/Shanghai"), 2026, 3, 10, 8, 0);
        assertTrigger(at(ZoneId.of("Asia/Shanghai"), 2026, 3, 10, 20, 30),
            "20:30", now, SHANGHAI);

        long atTrigger = at(ZoneId.of("Asia/Shanghai"), 2026, 3, 10, 20, 30);
        assertTrigger(at(ZoneId.of("Asia/Shanghai"), 2026, 3, 11, 20, 30),
            "20:30", atTrigger, SHANGHAI);

        long afterTrigger = at(ZoneId.of("Asia/Shanghai"), 2026, 3, 10, 20, 31);
        assertTrigger(at(ZoneId.of("Asia/Shanghai"), 2026, 3, 11, 20, 30),
            "20:30", afterTrigger, SHANGHAI);
    }

    @Test
    public void nextTriggerKeepsLocalWallClockAcrossDaylightSaving() throws Exception {
        TimeZone newYork = TimeZone.getTimeZone("America/New_York");
        ZoneId zone = ZoneId.of("America/New_York");
        // 2026-03-08 is the US spring-forward day; an 08:00 local reminder must stay
        // at 08:00 local (EDT), not arrive one wall-clock hour later.
        long now = at(zone, 2026, 3, 8, 1, 0);
        assertTrigger(at(zone, 2026, 3, 8, 8, 0), "08:00", now, newYork);
    }

    @Test
    public void nextTriggerRejectsInvalidTime() {
        try {
            ReminderScheduler.nextTriggerMillis("7:30", 0L, SHANGHAI);
            fail("Expected invalid reminder time to be rejected");
        } catch (UserException expected) {
            assertTrue(expected.getMessage().contains("HH:mm"));
        }
    }

    @Test
    public void exactAlarmDecisionRequiresAndroid12Permission() {
        assertEquals(ReminderScheduler.ScheduleMode.EXACT,
            ReminderScheduler.decideScheduleMode(26, true));
        assertEquals(ReminderScheduler.ScheduleMode.EXACT,
            ReminderScheduler.decideScheduleMode(30, true));
        assertEquals(ReminderScheduler.ScheduleMode.INEXACT,
            ReminderScheduler.decideScheduleMode(31, false));
        assertEquals(ReminderScheduler.ScheduleMode.INEXACT,
            ReminderScheduler.decideScheduleMode(35, false));
        assertEquals(ReminderScheduler.ScheduleMode.EXACT,
            ReminderScheduler.decideScheduleMode(31, true));
        assertEquals(ReminderScheduler.ScheduleMode.EXACT,
            ReminderScheduler.decideScheduleMode(35, true));
    }

    @Test
    public void bootReceiverRearmsForAllDeclaredSystemChanges() {
        assertTrue(BootReceiver.isRearmAction("android.intent.action.BOOT_COMPLETED"));
        assertTrue(BootReceiver.isRearmAction("android.intent.action.MY_PACKAGE_REPLACED"));
        assertTrue(BootReceiver.isRearmAction("android.intent.action.TIME_SET"));
        assertTrue(BootReceiver.isRearmAction("android.intent.action.TIMEZONE_CHANGED"));
        assertTrue(BootReceiver.isRearmAction("android.intent.action.DATE_CHANGED"));
        assertFalse(BootReceiver.isRearmAction("android.intent.action.SCREEN_ON"));
        assertFalse(BootReceiver.isRearmAction(null));
    }

    @Test
    public void manifestDeclaresExactAlarmAndRearmContract() throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        // Without namespace awareness getAttributeNS(ANDROID_NS, ...) returns an empty
        // string even though the manifest is well-formed, so the contract checks below
        // would silently compare blank values.
        factory.setNamespaceAware(true);
        Document document = factory.newDocumentBuilder().parse(manifestFile());
        document.getDocumentElement().normalize();

        Set<String> permissions = new HashSet<>();
        NodeList permissionNodes = document.getElementsByTagName("uses-permission");
        for (int index = 0; index < permissionNodes.getLength(); index++) {
            permissions.add(((Element) permissionNodes.item(index))
                .getAttributeNS(ANDROID_NS, "name"));
        }
        assertTrue("SCHEDULE_EXACT_ALARM must be declared",
            permissions.contains("android.permission.SCHEDULE_EXACT_ALARM"));
        assertTrue("RECEIVE_BOOT_COMPLETED must be declared",
            permissions.contains("android.permission.RECEIVE_BOOT_COMPLETED"));
        assertTrue("POST_NOTIFICATIONS must be declared",
            permissions.contains("android.permission.POST_NOTIFICATIONS"));

        Element bootReceiver = findReceiver(document, ".BootReceiver");
        assertNotNull("BootReceiver must be declared", bootReceiver);
        assertEquals("true", bootReceiver.getAttributeNS(ANDROID_NS, "exported"));
        assertEquals(new HashSet<>(Arrays.asList(
            "android.intent.action.BOOT_COMPLETED",
            "android.intent.action.MY_PACKAGE_REPLACED",
            "android.intent.action.TIME_SET",
            "android.intent.action.TIMEZONE_CHANGED",
            "android.intent.action.DATE_CHANGED"
        )), actionSet(bootReceiver));

        Element reminderReceiver = findReceiver(document, ".ReminderReceiver");
        assertNotNull("ReminderReceiver must be declared", reminderReceiver);
        assertEquals("false", reminderReceiver.getAttributeNS(ANDROID_NS, "exported"));

        Element exactReceiver = findReceiver(document, ".ExactAlarmPermissionReceiver");
        assertNotNull("ExactAlarmPermissionReceiver must be declared", exactReceiver);
        assertEquals("false", exactReceiver.getAttributeNS(ANDROID_NS, "exported"));
        assertEquals(new HashSet<>(Arrays.asList(
            ExactAlarmPermissionReceiver.ACTION
        )), actionSet(exactReceiver));
        assertEquals("android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED",
            ExactAlarmPermissionReceiver.ACTION);
    }

    private static void assertTrigger(long expected, String time, long now, TimeZone zone)
        throws Exception {
        assertEquals(expected, ReminderScheduler.nextTriggerMillis(time, now, zone));
    }

    private static long at(ZoneId zone, int year, int month, int day, int hour, int minute) {
        return ZonedDateTime.of(year, month, day, hour, minute, 0, 0, zone)
            .toInstant().toEpochMilli();
    }

    private static Set<String> actionSet(Element receiver) {
        Set<String> actions = new HashSet<>();
        NodeList nodes = receiver.getElementsByTagName("action");
        for (int index = 0; index < nodes.getLength(); index++) {
            actions.add(((Element) nodes.item(index)).getAttributeNS(ANDROID_NS, "name"));
        }
        return actions;
    }

    private static Element findReceiver(Document document, String name) {
        NodeList nodes = document.getElementsByTagName("receiver");
        for (int index = 0; index < nodes.getLength(); index++) {
            Element receiver = (Element) nodes.item(index);
            if (name.equals(receiver.getAttributeNS(ANDROID_NS, "name"))) {
                return receiver;
            }
        }
        return null;
    }

    private static File manifestFile() {
        File directory = new File(System.getProperty("user.dir", "."));
        while (directory != null) {
            File moduleManifest = new File(directory, "src/main/AndroidManifest.xml");
            if (moduleManifest.isFile()) {
                return moduleManifest;
            }
            File rootManifest = new File(directory, "app/src/main/AndroidManifest.xml");
            if (rootManifest.isFile()) {
                return rootManifest;
            }
            directory = directory.getParentFile();
        }
        throw new AssertionError("AndroidManifest.xml not found from "
            + System.getProperty("user.dir"));
    }
}
