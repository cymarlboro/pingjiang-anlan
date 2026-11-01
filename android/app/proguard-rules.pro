# JavaScript bridge methods must stay available if shrinking is ever enabled.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class cn.pingjianganlan.study.NativeBridge { *; }
