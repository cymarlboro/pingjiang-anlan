package cn.pingjianganlan.study;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

public class UrlRulesTest {
    @Test
    public void normalizesTrailingSlashAndChatEndpoint() throws Exception {
        assertEquals("https://api.example.com/v1",
            UrlRules.normalizeApiBase("https://api.example.com/v1/"));
        assertEquals("https://api.example.com/v1",
            UrlRules.normalizeApiBase("https://api.example.com/v1/chat/completions"));
        assertEquals("https://api.example.com",
            UrlRules.normalizeApiBase("https://api.example.com/models"));
    }

    @Test
    public void localHttpIsTheOnlyPlainHttp() throws Exception {
        assertEquals("http://localhost:11434",
            UrlRules.normalizeApiBase("http://localhost:11434/"));
        assertEquals("http://127.0.0.1:8080/v1",
            UrlRules.normalizeApiBase("http://127.0.0.1:8080/v1"));
        assertRejected("http://api.example.com/v1");
        assertRejected("http://localhost.evil.example/v1");
    }

    @Test
    public void httpsRejectsUserInfoQueryAndFragment() {
        assertRejected("https://user:pass@api.example.com/v1");
        assertRejected("https://api.example.com/v1?key=x");
        assertRejected("https://api.example.com/v1#fragment");
        assertRejected("ftp://api.example.com/v1");
    }

    @Test
    public void updateManifestRequiresHttpsButMayCarryQuery() throws Exception {
        assertEquals("https://example.com/update.json?token=abc",
            UrlRules.normalizeUpdateManifestUrl("https://example.com/update.json?token=abc"));
        assertRejectedUpdate("http://example.com/update.json");
        assertRejectedUpdate("https://user@example.com/update.json");
        assertRejectedUpdate("https://example.com/update.json#x");
        assertEquals("", UrlRules.normalizeUpdateManifestUrl("  "));
    }

    @Test
    public void relativePathSegmentsAreRejected() {
        assertRejected("https://example.com/v1/../secret");
    }

    private static void assertRejected(String value) {
        try {
            UrlRules.normalizeApiBase(value);
            fail("Expected rejection: " + value);
        } catch (UrlRules.InvalidUrlException expected) {
            assertTrue(expected.getMessage() != null && !expected.getMessage().isEmpty());
        }
    }

    private static void assertRejectedUpdate(String value) {
        try {
            UrlRules.normalizeUpdateManifestUrl(value);
            fail("Expected rejection: " + value);
        } catch (UrlRules.InvalidUrlException expected) {
            assertFalse(expected.getMessage() == null);
        }
    }
}
