package cn.pingjianganlan.study;

/** An expected failure whose message is safe to show to the user. */
public class UserException extends Exception {
    public UserException(String message) {
        super(message);
    }

    public UserException(String message, Throwable cause) {
        super(message, cause);
    }
}
