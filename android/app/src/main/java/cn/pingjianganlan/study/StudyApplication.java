package cn.pingjianganlan.study;

import android.app.Application;

import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;

public final class StudyApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        PDFBoxResourceLoader.init(getApplicationContext());
        ReminderScheduler.ensureChannel(this);
    }
}
