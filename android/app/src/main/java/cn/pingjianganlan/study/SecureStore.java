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
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Stores only the API key ciphertext. The AES key is non-exportable and lives in
 * AndroidKeyStore. Plaintext is never written to preferences, files, backups, or logs.
 */
public final class SecureStore {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "scj_api_key_v1";
    private static final String PREFS = "scj_secure_v1";
    private static final String PREF_CIPHERTEXT = "key_ciphertext";
    private static final byte[] AAD = "cn.pingjianganlan.study.api".getBytes(StandardCharsets.UTF_8);
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;

    private final SharedPreferences preferences;
    private final SecureRandom random = new SecureRandom();

    public SecureStore(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public synchronized boolean save(String plaintext) throws UserException {
        if (plaintext == null || plaintext.trim().isEmpty()) {
            throw new UserException("API Key 不能为空");
        }
        String value = plaintext.trim();
        if (value.length() > 8192) {
            throw new UserException("API Key 过长");
        }
        try {
            SecretKey secretKey = getOrCreateKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            // Let AndroidKeyStore generate a fresh IV; caller-supplied IVs are
            // incompatible with randomized-encryption enforcement on some devices.
            cipher.init(Cipher.ENCRYPT_MODE, secretKey);
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length != IV_BYTES) {
                throw new GeneralSecurityException("Unexpected GCM IV length");
            }
            cipher.updateAAD(AAD);
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            JSONObject payload = new JSONObject();
            payload.put("v", 1);
            payload.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
            payload.put("ct", Base64.encodeToString(encrypted, Base64.NO_WRAP));
            boolean written = preferences.edit()
                .putString(PREF_CIPHERTEXT, payload.toString())
                .commit();
            if (!written) {
                throw new UserException("API Key 保存失败");
            }
            return true;
        } catch (UserException exception) {
            throw exception;
        } catch (GeneralSecurityException | JSONException exception) {
            clearQuietly();
            throw new UserException("API Key 加密保存失败", exception);
        }
    }

    /** Returns null when no key is saved or the stored ciphertext cannot be opened. */
    public synchronized String load() {
        String raw = preferences.getString(PREF_CIPHERTEXT, null);
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        try {
            JSONObject payload = new JSONObject(raw);
            if (payload.optInt("v", 0) != 1) {
                clearQuietly();
                return null;
            }
            byte[] iv = Base64.decode(payload.getString("iv"), Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(payload.getString("ct"), Base64.NO_WRAP);
            if (iv.length != IV_BYTES || ciphertext.length == 0) {
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
            byte[] decrypted = cipher.doFinal(ciphertext);
            return new String(decrypted, StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | JSONException | IOException |
                 IllegalArgumentException exception) {
            // A lost/invalidated Keystore key makes this ciphertext permanently
            // unreadable. Remove only the unusable ciphertext, never user content.
            clearQuietly();
            return null;
        }
    }

    public synchronized boolean hasKey() {
        return load() != null;
    }

    public synchronized void clear() {
        preferences.edit().remove(PREF_CIPHERTEXT).commit();
    }

    private void clearQuietly() {
        try {
            preferences.edit().remove(PREF_CIPHERTEXT).commit();
        } catch (RuntimeException ignored) {
            // Best effort only.
        }
    }

    private SecretKey getOrCreateKey() throws GeneralSecurityException {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        try {
            keyStore.load(null);
        } catch (java.io.IOException exception) {
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
