package fr.pokeveille.autoclicker;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Service d'accessibilité : affiche le panneau flottant et la cible, et envoie les clics
 * (dispatchGesture, seul moyen sans root de toucher l'écran à la place de l'utilisateur).
 *
 * Toute action déclenchée pendant que l'auto-clicker tourne se fait au POSER du doigt :
 * chaque clic injecté annule le geste réel en cours, le « lever » du doigt n'arriverait jamais.
 */
public class ClickService extends AccessibilityService
        implements SharedPreferences.OnSharedPreferenceChangeListener {

    private static final int COLOR_GO = 0xFF2E7D32;
    private static final int COLOR_STOP = 0xFFC62828;
    private static final int COLOR_HOLD = 0xFF1565C0;
    private static final int COLOR_SMALL = 0xFF424242;
    /** Laisse le temps à la cible de devenir « traversable » avant le premier clic. */
    private static final long FIRST_CLICK_DELAY_MS = 60;

    private static ClickService instance;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private WindowManager wm;

    private LinearLayout panel;
    private WindowManager.LayoutParams panelParams;
    private TextView mainButton;
    private TextView speedLabel;
    private TargetView target;
    private WindowManager.LayoutParams targetParams;

    private boolean screenOffRegistered;
    /** Taille d'écran pour laquelle la cible et le panneau sont placés. */
    private Point placedFor;
    private boolean clicking;
    private float clickX;
    private float clickY;
    private long nextClickAt;

    private final Runnable clickLoop = new Runnable() {
        @Override
        public void run() {
            if (!clicking) return;
            long interval = 1000L / Prefs.cps(prefs);
            tap(clickX, clickY, Math.max(1, Math.min(10, interval / 2)));
            long now = SystemClock.uptimeMillis();
            nextClickAt = Math.max(nextClickAt + interval, now);
            handler.postAtTime(this, nextClickAt);
        }
    };

    private final BroadcastReceiver screenOff = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            stopClicking();
        }
    };

    /** Instance connectée, ou null si le service n'est pas activé dans Accessibilité. */
    static ClickService get() {
        return instance;
    }

    @Override
    protected void onServiceConnected() {
        instance = this;
        prefs = Prefs.get(this);
        prefs.registerOnSharedPreferenceChangeListener(this);
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_OFF);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // Diffusion protégée : seul le système peut l'envoyer.
                registerReceiver(screenOff, filter, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(screenOff, filter);
            }
            screenOffRegistered = true;
        } catch (RuntimeException e) {
            // Simple sécurité en plus : le service doit démarrer même sans elle.
            App.logError(this, "Écran éteint", e);
        }
    }

    @Override
    public void onDestroy() {
        if (instance == this) {
            hideOverlay();
            prefs.unregisterOnSharedPreferenceChangeListener(this);
            if (screenOffRegistered) unregisterReceiver(screenOff);
            instance = null;
        }
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Rien à lire : le service ne sert qu'à envoyer des clics.
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // Laisse au système le temps d'appliquer la nouvelle orientation avant de mesurer.
        handler.postDelayed(this::fitToScreen, 150);
    }

    @Override
    public void onInterrupt() {
        stopClicking();
    }

    @Override
    protected boolean onKeyEvent(KeyEvent event) {
        if (panel == null || event.getKeyCode() != Prefs.hwKeyCode(prefs)) return false;
        boolean hold = Prefs.mode(prefs) == Prefs.MODE_HOLD;
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            if (hold || !clicking) startClicking();
            else stopClicking();
        } else if (event.getAction() == KeyEvent.ACTION_UP && hold) {
            stopClicking();
        }
        return true; // la touche ne change pas le volume tant que le panneau est affiché
    }

    @Override
    public void onSharedPreferenceChanged(SharedPreferences p, String key) {
        if (Prefs.KEY_MODE.equals(key) || Prefs.KEY_HW.equals(key)) stopClicking();
        refreshPanel();
    }

    boolean isOverlayShown() {
        return panel != null;
    }

    /** @return false si Android a refusé d'afficher le panneau (erreur enregistrée). */
    boolean showOverlay() {
        if (panel != null) return true;
        try {
            addOverlay();
            return true;
        } catch (RuntimeException e) {
            App.logError(this, "Affichage du bouton flottant", e);
            hideOverlay();
            return false;
        }
    }

    private void addOverlay() {
        Point screen = screenSize();
        placedFor = screen;

        target = new TargetView(this);
        int targetSize = dp(56);
        targetParams = overlayParams(targetSize, targetSize);
        targetParams.x = prefs.getInt("target_x", screen.x / 2 - targetSize / 2);
        targetParams.y = prefs.getInt("target_y", screen.y / 2 - targetSize / 2);
        clamp(targetParams, targetSize, targetSize);
        target.setOnTouchListener(new Dragger(target, targetParams, "target", null));
        wm.addView(target, targetParams);

        panel = buildPanel();
        panelParams = overlayParams(WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT);
        panelParams.x = prefs.getInt("panel_x", dp(8));
        panelParams.y = prefs.getInt("panel_y", screen.y / 3);
        clamp(panelParams, dp(72), dp(160));
        wm.addView(panel, panelParams);
        refreshPanel();
    }

    void hideOverlay() {
        stopClicking();
        removeQuietly(panel);
        removeQuietly(target);
        panel = null;
        target = null;
    }

    private void removeQuietly(View view) {
        if (view == null) return;
        try {
            wm.removeView(view);
        } catch (RuntimeException ignored) {
            // Fenêtre jamais ajoutée (échec de l'affichage) ou déjà retirée par le système.
        }
    }

    private void startClicking() {
        if (clicking || target == null) return;
        int[] loc = new int[2];
        target.getLocationOnScreen(loc);
        clickX = loc[0] + target.getWidth() / 2f;
        clickY = loc[1] + target.getHeight() / 2f;
        clicking = true;
        setTargetTouchable(false); // sinon les clics tomberaient sur la cible elle-même
        nextClickAt = SystemClock.uptimeMillis() + FIRST_CLICK_DELAY_MS;
        handler.postAtTime(clickLoop, nextClickAt);
        refreshPanel();
    }

    private void stopClicking() {
        if (!clicking) return;
        clicking = false;
        handler.removeCallbacks(clickLoop);
        setTargetTouchable(true);
        refreshPanel();
    }

    private void tap(float x, float y, long durationMs) {
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, durationMs))
                .build();
        dispatchGesture(gesture, null, null);
    }

    // --- Panneau flottant -------------------------------------------------------------------

    private LinearLayout buildPanel() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(6), dp(6), dp(6), dp(6));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xDD202020);
        bg.setCornerRadius(dp(16));
        root.setBackground(bg);

        mainButton = roundText(dp(60), 22, COLOR_GO);
        mainButton.setOnTouchListener(new Dragger(root, null, "panel", this::onMainTap) {
            @Override
            boolean onDown() {
                if (!clicking) return false;
                stopClicking();
                return true;
            }
        });
        root.addView(mainButton);

        speedLabel = new TextView(this);
        speedLabel.setTextColor(0xFFFFFFFF);
        speedLabel.setTextSize(13);
        speedLabel.setGravity(Gravity.CENTER);
        speedLabel.setPadding(0, dp(4), 0, dp(4));
        root.addView(speedLabel);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        TextView minus = roundText(dp(32), 18, COLOR_SMALL);
        minus.setText("−");
        onPress(minus, () -> setCps(Prefs.stepDown(Prefs.cps(prefs))));
        TextView plus = roundText(dp(32), 18, COLOR_SMALL);
        plus.setText("+");
        onPress(plus, () -> setCps(Prefs.stepUp(Prefs.cps(prefs))));
        row.addView(minus);
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(dp(32), dp(32));
        gap.leftMargin = dp(4);
        row.addView(plus, gap);
        root.addView(row);

        TextView close = roundText(dp(32), 15, COLOR_SMALL);
        close.setText("✕");
        onPress(close, this::hideOverlay);
        LinearLayout.LayoutParams closeLp = new LinearLayout.LayoutParams(dp(32), dp(32));
        closeLp.topMargin = dp(6);
        root.addView(close, closeLp);
        return root;
    }

    private void refreshPanel() {
        if (panel == null) return;
        int cps = Prefs.cps(prefs);
        speedLabel.setText(cps + "/s");
        GradientDrawable bg = (GradientDrawable) mainButton.getBackground();
        if (clicking) {
            mainButton.setText("■");
            mainButton.setTextSize(22);
            bg.setColor(COLOR_STOP);
        } else if (Prefs.mode(prefs) == Prefs.MODE_HOLD) {
            mainButton.setText(Prefs.hwKey(prefs) == Prefs.HW_VOL_UP ? "Vol+" : "Vol−");
            mainButton.setTextSize(15);
            bg.setColor(COLOR_HOLD);
        } else {
            mainButton.setText("▶");
            mainButton.setTextSize(22);
            bg.setColor(COLOR_GO);
        }
    }

    private void onMainTap() {
        if (Prefs.mode(prefs) == Prefs.MODE_HOLD) {
            Toast.makeText(this, getString(R.string.toast_hold, Prefs.hwKeyLabel(this, prefs)),
                    Toast.LENGTH_SHORT).show();
        } else {
            startClicking();
        }
    }

    private void setCps(int cps) {
        prefs.edit().putInt(Prefs.KEY_CPS, cps).apply();
    }

    private void setTargetTouchable(boolean touchable) {
        if (target == null || !target.isAttachedToWindow()) return;
        if (touchable) targetParams.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        else targetParams.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        target.setAlpha(touchable ? 1f : 0.7f);
        wm.updateViewLayout(target, targetParams);
    }

    private TextView roundText(int size, int textSp, int color) {
        TextView t = new TextView(this);
        t.setLayoutParams(new LinearLayout.LayoutParams(size, size));
        t.setGravity(Gravity.CENTER);
        t.setTextColor(0xFFFFFFFF);
        t.setTextSize(textSp);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(color);
        t.setBackground(bg);
        return t;
    }

    /** Agit dès que le doigt se pose (voir l'en-tête de la classe). */
    private static void onPress(View view, Runnable action) {
        view.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_DOWN) action.run();
            return true;
        });
    }

    // --- Fenêtres ---------------------------------------------------------------------------

    private WindowManager.LayoutParams overlayParams(int width, int height) {
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(width, height,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        return lp;
    }

    /**
     * Après une rotation (jeu en paysage…), garde la cible et le panneau au même endroit
     * relatif : sinon la cible placée au milieu de l'écran en portrait sort de l'écran.
     */
    private void fitToScreen() {
        if (panel == null) return;
        Point screen = screenSize();
        if (screen.equals(placedFor)) return;
        stopClicking(); // le point visé ne correspond plus à rien
        moveProportionally(target, targetParams, placedFor, screen);
        moveProportionally(panel, panelParams, placedFor, screen);
        placedFor = screen;
    }

    private void moveProportionally(View view, WindowManager.LayoutParams lp, Point from, Point to) {
        int w = view.getWidth();
        int h = view.getHeight();
        float cx = (lp.x + w / 2f) / from.x;
        float cy = (lp.y + h / 2f) / from.y;
        lp.x = Math.round(cx * to.x - w / 2f);
        lp.y = Math.round(cy * to.y - h / 2f);
        clamp(lp, w, h);
        try {
            wm.updateViewLayout(view, lp);
        } catch (RuntimeException ignored) {
            // Fenêtre retirée entre-temps.
        }
    }

    private Point screenSize() {
        DisplayMetrics m = new DisplayMetrics();
        Display display = getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY);
        if (display != null) display.getRealMetrics(m);
        else m = getResources().getDisplayMetrics();
        return new Point(m.widthPixels, m.heightPixels);
    }

    /** Garde la fenêtre entièrement à l'écran (ex. après une rotation). */
    private void clamp(WindowManager.LayoutParams lp, int width, int height) {
        Point screen = screenSize();
        lp.x = Math.max(0, Math.min(screen.x - width, lp.x));
        lp.y = Math.max(0, Math.min(screen.y - height, lp.y));
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /**
     * Déplace une fenêtre flottante en glissant ; un appui sans glisser déclenche onTap.
     * params null = ceux du panneau, créés après son bouton principal.
     */
    private class Dragger implements View.OnTouchListener {
        private final View window;
        private final WindowManager.LayoutParams fixedParams;
        private final String prefKey;
        private final Runnable onTap;
        private final int slop;
        private float downX;
        private float downY;
        private int startX;
        private int startY;
        private boolean dragging;
        private boolean handledOnDown;

        Dragger(View window, WindowManager.LayoutParams params, String prefKey, Runnable onTap) {
            this.window = window;
            this.fixedParams = params;
            this.prefKey = prefKey;
            this.onTap = onTap;
            this.slop = ViewConfiguration.get(ClickService.this).getScaledTouchSlop();
        }

        /** @return true si l'appui a été entièrement traité au poser du doigt. */
        boolean onDown() {
            return false;
        }

        private WindowManager.LayoutParams params() {
            return fixedParams != null ? fixedParams : panelParams;
        }

        @Override
        public boolean onTouch(View v, MotionEvent e) {
            WindowManager.LayoutParams lp = params();
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    handledOnDown = onDown();
                    downX = e.getRawX();
                    downY = e.getRawY();
                    startX = lp.x;
                    startY = lp.y;
                    dragging = false;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    if (handledOnDown) return true;
                    float dx = e.getRawX() - downX;
                    float dy = e.getRawY() - downY;
                    if (!dragging && Math.hypot(dx, dy) > slop) dragging = true;
                    if (dragging) {
                        lp.x = startX + Math.round(dx);
                        lp.y = startY + Math.round(dy);
                        clamp(lp, window.getWidth(), window.getHeight());
                        wm.updateViewLayout(window, lp);
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                    if (handledOnDown) return true;
                    if (dragging) {
                        prefs.edit()
                                .putInt(prefKey + "_x", lp.x)
                                .putInt(prefKey + "_y", lp.y)
                                .apply();
                    } else if (onTap != null) {
                        onTap.run();
                    }
                    return true;
                default:
                    return true;
            }
        }
    }
}
