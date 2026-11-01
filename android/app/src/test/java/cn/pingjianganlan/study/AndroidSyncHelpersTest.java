package cn.pingjianganlan.study;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.util.HashSet;
import java.util.Set;

/**
 * Pure JVM checks for sync helpers. No Android Context, network, account, token, or
 * JSON stub is used here; HTTP behavior is covered by source-contract checks.
 */
public class AndroidSyncHelpersTest {
    @Test
    public void randomIdsStayInsideTheCrossPlatformRange() {
        for (int index = 0; index < 2000; index++) {
            long id = SecureIds.randomId();
            assertTrue("id below range: " + id, SecureIds.isInRange(id));
            assertTrue(id >= 1_000_000_000_000L);
            assertTrue(id < (1L << 52));
            assertTrue(id <= NativeStore.MAX_JS_SAFE_INTEGER);
        }
    }

    @Test
    public void randomIdBatchHasNoObservedCollision() {
        Set<Long> ids = new HashSet<>();
        for (int index = 0; index < 500; index++) {
            ids.add(SecureIds.randomId());
        }
        assertEquals(500, ids.size());
    }

    @Test
    public void ownerIdsMustBeCanonicalUuids() throws Exception {
        String id = "8c2e1f2a-0f4c-4f87-9fd4-1c0a8f2d7b61";
        assertEquals(id, SyncOwner.normalize(id.toUpperCase()));
        assertTrue(SyncOwner.isUuid(id));
        assertFalse(SyncOwner.isUuid(""));
        assertFalse(SyncOwner.isUuid("not-a-uuid"));
        assertFalse(SyncOwner.isUuid(id + "&select=*"));
        try {
            SyncOwner.normalize("8c2e1f2a-0f4c-4f87-9fd4-1c0a8f2d7b61&x=1");
            fail("Expected non-UUID owner to be rejected");
        } catch (UserException expected) {
            assertTrue(expected.getMessage().contains("账户标识"));
        }
    }

    @Test
    public void transportAllowsOnlyTheTwoFixedSyncPaths() {
        String owner = "8c2e1f2a-0f4c-4f87-9fd4-1c0a8f2d7b61";
        assertTrue(CloudSyncClient.isAllowedPath(
            "/rest/v1/pja_learning_state?select=revision,payload&owner_id=eq." + owner));
        assertTrue(CloudSyncClient.isAllowedPath("/rest/v1/rpc/pja_sync_commit"));
        assertFalse(CloudSyncClient.isAllowedPath("/auth/v1/user"));
        assertFalse(CloudSyncClient.isAllowedPath(
            "/rest/v1/pja_learning_state?select=revision,payload&owner_id=eq." + owner + "&x=1"));
        assertFalse(CloudSyncClient.isAllowedPath(
            "/rest/v1/pja_learning_state?select=revision,payload&owner_id=eq.not-a-uuid"));
        assertFalse(CloudSyncClient.isAllowedPath("/rest/v1/rpc/other_function"));
        assertEquals(16 * 1024 * 1024, CloudSyncClient.MAX_BUNDLE_BYTES);
        assertEquals(20 * 1024 * 1024, CloudSyncClient.MAX_RESPONSE_BYTES);
    }

    @Test
    public void revisionMustBeASafeNonNegativeInteger() {
        assertTrue(CloudSyncClient.isSafeRevision(0));
        assertTrue(CloudSyncClient.isSafeRevision(0L));
        assertTrue(CloudSyncClient.isSafeRevision(NativeStore.MAX_JS_SAFE_INTEGER));
        assertFalse(CloudSyncClient.isSafeRevision(-1));
        assertFalse(CloudSyncClient.isSafeRevision(1.5d));
        assertFalse(CloudSyncClient.isSafeRevision("1"));
        assertFalse(CloudSyncClient.isSafeRevision(null));
        assertFalse(CloudSyncClient.isSafeRevision(
            NativeStore.MAX_JS_SAFE_INTEGER + 1.0d));
    }
}
