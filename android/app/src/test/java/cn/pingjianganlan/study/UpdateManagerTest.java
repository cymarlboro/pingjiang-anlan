package cn.pingjianganlan.study;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Pure update policy checks; no network or package installation is exercised. */
public class UpdateManagerTest {
    @Test
    public void officialManifestIsTheDocumentedDefault() {
        assertEquals("https://raw.githubusercontent.com/cymarlboro/pingjiang-anlan/main/update.json",
            UpdateManager.DEFAULT_UPDATE_MANIFEST_URL);
    }

    @Test
    public void autoCheckThrottleAllowsFirstAndIntervalThenSuppresses() {
        long now = 1_800_000_000_000L;
        long interval = UpdateManager.AUTO_CHECK_INTERVAL_MS;
        assertTrue(UpdateManager.shouldAutoCheck(0L, now, interval));
        assertTrue(UpdateManager.shouldAutoCheck(now - interval, now, interval));
        assertFalse(UpdateManager.shouldAutoCheck(now - interval + 1L, now, interval));
        assertFalse(UpdateManager.shouldAutoCheck(now - 1000L, now, interval));
        // A clock rollback should not suppress updates forever.
        assertTrue(UpdateManager.shouldAutoCheck(now + 1000L, now, interval));
    }
}
