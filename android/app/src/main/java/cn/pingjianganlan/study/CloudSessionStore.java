package cn.pingjianganlan.study;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Encrypted storage for the optional Supabase Auth session.
 *
 * <p>This class deliberately uses a different preferences file, AndroidKeyStore
 * alias, and AAD than the existing model API-key store. The API-key store is never
 * read, changed, or cleared from here. The complete session JSON (including the
 * refresh token) is encrypted with AES/GCM before it touches SharedPreferences.
 * Passwords are never accepted by this class and must never be placed in the
 * session object.
 *
 * <p>The app already declares {@code android:allowBackup="false"}, so this file is
 * excluded from Android backup together with the rest of the app's private data.
 */
public final class CloudSessionStore {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "scj_cloud_session_key_v1";
    private static final String PREFS = "scj_cloud_session_v1";
    private static final String PREF_PAYLOAD = "session_payload";
    private static final byte[] AAD =
        "cn.pingjianganlan.study.cloud.session".getBytes(StandardCharsets.UTF_8);
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;
    private static final int MAX_PLAINTEXT_BYTES = 32 * 1024;
    private static final int MAX_CIPHERTEXT_BYTES = 40 * 1024;
    private static final int MAX_ENCODED_CHARS = 64 * 1024;

    private final SharedPreferences preferences;

    public CloudSessionStore(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("context");
        }
        Context application = context.getApplicationContext();
        Context target = application == null ? context : application;
        preferences = target.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Encrypts and replaces the stored session. The caller is responsible for
     * putting only sanitized session fields in {@code session}; a password field is
     * rejected here as a second line of defence.
     */
    public synchronized void save(JSONObject session) throws UserException {
        if (session == null || session.length() == 0) {
            throw new UserException("云端会话内容为空");
        }
        if (session.has("password") || session.has("new_password")) {
            throw new UserException("云端会话不能保存密码");
        }
        final String plaintext;
        try {
            plaintext = session.toString();
        } catch (RuntimeException exception) {
            throw new UserException("云端会话整理失败", exception);
        }
        byte[] bytes = plaintext.getBytes(StandardCharsets.UTF_8);
        if (bytes.length == 0 || bytes.length > MAX_PLAINTEXT_BYTES) {
            throw new UserException("云端会话数据过大");
        }
        try {
            SecretKey secretKey = getOrCreateKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            // AndroidKeyStore generates a fresh IV; callers never supply one.
            cipher.init(Cipher.ENCRYPT_MODE, secretKey);
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length != IV_BYTES) {
                throw new GeneralSecurityException("Unexpected GCM IV length");
            }
            cipher.updateAAD(AAD);
            byte[] encrypted = cipher.doFinal(bytes);
            if (encrypted.length == 0 || encrypted.length > MAX_CIPHERTEXT_BYTES) {
                throw new GeneralSecurityException("Unexpected ciphertext length");
            }
            JSONObject payload = new JSONObject();
            payload.put("v", 1);
            payload.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
            payload.put("ct", Base64.encodeToString(encrypted, Base64.NO_WRAP));
            boolean written = preferences.edit()
                .putString(PREF_PAYLOAD, payload.toString())
                .commit();
            if (!written) {
                clearQuietly();
                throw new UserException("云端会话保存失败");
            }
        } catch (UserException exception) {
            throw exception;
        } catch (GeneralSecurityException | JSONException exception) {
            // Never leave a partially written or unreadable auth state behind.
            clearQuietly();
            throw new UserException("云端会话加密保存失败", exception);
        }
    }

    /** Returns null when nothing is stored or the ciphertext cannot be opened. */
    public synchronized JSONObject load() {
        String raw = preferences.getString(PREF_PAYLOAD, null);
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        if (raw.length() > MAX_ENCODED_CHARS) {
            clearQuietly();
            return null;
        }
        try {
            JSONObject payload = new JSONObject(raw);
            if (payload.optInt("v", 0) != 1) {
                clearQuietly();
                return null;
            }
            String ivText = payload.optString("iv", "");
            String cipherText = payload.optString("ct", "");
            if (ivText.isEmpty() || cipherText.isEmpty()) {
                clearQuietly();
                return null;
            }
            byte[] iv = Base64.decode(ivText, Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(cipherText, Base64.NO_WRAP);
            if (iv.length != IV_BYTES || encrypted.length == 0 ||
                encrypted.length > MAX_CIPHERTEXT_BYTES) {
                clearQuietly();
                return null;
            }
            KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
            keyStore.load(null);
            if (!keyStore.containsAlias(ALIAS)) {
                clearQuietly();
                return null;
            }
            SecretKey secretKey = (SecretKey) keyStore.getKey(ALIAS, null);
            if (secretKey == null) {
                clearQuietly();
                return null;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_BITS, iv));
            cipher.updateAAD(AAD);
            byte[] decrypted = cipher.doFinal(encrypted);
            if (decrypted.length == 0 || decrypted.length > MAX_PLAINTEXT_BYTES) {
                clearQuietly();
                return null;
            }
            JSONObject session = new JSONObject(new String(decrypted, StandardCharsets.UTF_8));
            if (session.length() == 0 || session.has("password")) {
                clearQuietly();
                return null;
            }
            return session;
        } catch (GeneralSecurityException | JSONException | IOException |
                 IllegalArgumentException exception) {
            // A lost or invalidated Keystore key makes this ciphertext permanently
            // unreadable. Remove only the cloud session state.
            clearQuietly();
            return null;
        }
    }

    public synchronized boolean hasState() {
        return load() != null;
    }

    /** Clears the cloud session only; the API key store is a different file. */
    public synchronized void clear() {
        clearQuietly();
    }

    private void clearQuietly() {
        try {
            preferences.edit().remove(PREF_PAYLOAD).commit();
        } catch (RuntimeException ignored) {
            // Best effort only.
        }
    }

    private SecretKey getOrCreateKey() throws GeneralSecurityException {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        try {
            keyStore.load(null);
        } catch (IOException exception) {
            throw new GeneralSecurityException("Keystore unavailable", exception);
        }
        if (keyStore.containsAlias(ALIAS)) {
            return (SecretKey) keyStore.getKey(ALIAS, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }
}
