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
 *
 * Deux cibles : la rouge reçoit l'auto-clic continu, la bleue (facultative) reçoit la macro,
 * une rafale de quelques clics rapprochés déclenchée par l'autre touche de volume (rafales
 * enchaînées tant qu'elle est maintenue) ou par le bouton flottant ⚡.
 */
public class ClickService extends AccessibilityService
        implements SharedPreferences.OnSharedPreferenceChangeListener {

    private static final int COLOR_GO = 0xFF2E7D32;
    private static final int COLOR_STOP = 0xFFC62828;
    private static final int COLOR_HOLD = 0xFF1565C0;
    private static final int COLOR_SMALL = 0xFF424242;
    private static final int COLOR_TARGET = 0xFFE53935;
    private static final int COLOR_MACRO_TARGET = 0xFF1E88E5;
    /** Laisse le temps à la cible de devenir « traversable » avant le premier clic. */
    private static final long FIRST_CLICK_DELAY_MS = 60;
    private static final int MAX_STROKES_PER_GESTURE = 20;
    private static final double BATCH_SPAN_MS = 50;

    private static ClickService instance;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private WindowManager wm;

    private LinearLayout panel;
    private WindowManager.LayoutParams panelParams;
    private TextView mainButton;
    private TextView speedLabel;
    private MacroButtonView macroButton;
    private WindowManager.LayoutParams macroButtonParams;
    private TextView lockButton;
    private TargetView target;
    private WindowManager.LayoutParams targetParams;
    private TargetView macroTarget;
    private WindowManager.LayoutParams macroParams;
    /** Cibles verrouillées : traversables en permanence, la macro part sans délai. */
    private boolean locked;
    private boolean macroFiring;
    /** Rafales enchaînées : touche de la macro maintenue, ou bouton ⚡ en mode continu. */
    private boolean macroRepeat;
    private final Runnable nextMacro = () -> {
        if (macroRepeat) fireMacro();
    };

    private boolean screenOffRegistered;
    /** Taille d'écran pour laquelle la cible et le panneau sont placés. */
    private Point placedFor;
    private boolean clicking;
    private float clickX;
    private float clickY;
    /** Heure (uptimeMillis) du prochain envoi, en double pour ne pas dériver à 300 ou 500 clics/s. */
    private double nextBatchAt;

    /** Change à chaque démarrage : les fins de gestes d'une session précédente sont ignorées. */
    private int session;

    /**
     * Chaque geste envoyé à Android regroupe les clics des ~50 prochaines ms (jusqu'à 20) :
     * un envoi par clic ne suit pas au-delà de ~50 clics/s, et des paquets courts gardent
     * l'arrêt immédiat. Le paquet suivant part quand le précédent est fini : un nouveau
     * geste annulerait le dernier clic encore en cours.
     */
    private final Runnable clickLoop = new Runnable() {
        @Override
        public void run() {
            if (!clicking || macroFiring) return;
            int cps = Prefs.cps(prefs);
            double interval = 1000.0 / cps;
            int fingers = Prefs.fingers(prefs);
            int maxStrokes = Math.min(MAX_STROKES_PER_GESTURE, GestureDescription.getMaxStrokeCount());
            int maxTaps = Math.max(1, maxStrokes / fingers);
            int taps = Math.max(1, Math.min(maxTaps, (int) (BATCH_SPAN_MS / interval)));
            long duration = Math.max(1, Math.min(10, (long) (interval / 2)));
            nextBatchAt += taps * interval;
            if (!tapBurst(clickX, clickY, fingers, taps, interval, duration, session)) {
                scheduleNextBatch();
            }
        }
    };

    private void scheduleNextBatch() {
        if (!clicking || macroFiring) return; // la fin de la macro relance la boucle
        handler.removeCallbacks(clickLoop);
        nextBatchAt = Math.max(nextBatchAt, SystemClock.uptimeMillis());
        handler.postAtTime(clickLoop, (long) Math.ceil(nextBatchAt));
    }

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
        if (panel == null) return false;
        if (Prefs.macroOn(prefs) && event.getKeyCode() == Prefs.macroKeyCode(prefs)) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                startMacroRepeat();
            } else if (event.getAction() == KeyEvent.ACTION_UP) {
                stopMacroRepeat(); // la rafale en cours va jusqu'au bout
            }
            return true;
        }
        if (event.getKeyCode() != Prefs.hwKeyCode(prefs)) return false;
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
        // Le nombre de doigts et la vitesse sont relus à chaque paquet : pas besoin d'arrêter.
        if (Prefs.KEY_MACRO_ON.equals(key) && panel != null) {
            if (Prefs.macroOn(prefs)) showMacroTarget();
            else hideMacroTarget();
        }
        if (Prefs.KEY_MACRO_BUTTON_MODE.equals(key)) stopMacroRepeat();
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

        locked = false;
        target = new TargetView(this, COLOR_TARGET);
        targetParams = addTarget(target, "target", screen.x / 2, screen.y / 2);
        if (Prefs.macroOn(prefs)) showMacroTarget();

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
        stopMacroRepeat();
        macroFiring = false;
        hideMacroTarget();
        removeQuietly(panel);
        removeQuietly(target);
        panel = null;
        target = null;
    }

    /** Ajoute une cible déplaçable centrée par défaut sur (centerX, centerY). */
    private WindowManager.LayoutParams addTarget(TargetView view, String prefKey, int centerX, int centerY) {
        int size = dp(56);
        WindowManager.LayoutParams lp = overlayParams(size, size);
        lp.x = prefs.getInt(prefKey + "_x", centerX - size / 2);
        lp.y = prefs.getInt(prefKey + "_y", centerY - size / 2);
        clamp(lp, size, size);
        view.setOnTouchListener(new Dragger(view, lp, prefKey, null));
        wm.addView(view, lp);
        return lp;
    }

    /** Cible bleue et bouton ⚡ : affichés ensemble quand la macro est activée. */
    private void showMacroTarget() {
        if (macroTarget != null) return;
        Point screen = screenSize();
        macroTarget = new TargetView(this, COLOR_MACRO_TARGET);
        macroButton = new MacroButtonView(this);
        try {
            // Par défaut en bas à droite, là où les jeux mettent souvent leurs boutons d'action.
            macroParams = addTarget(macroTarget, "macro", screen.x - dp(110), screen.y - dp(170));
            int size = dp(72);
            macroButtonParams = overlayParams(size, size);
            macroButtonParams.x = prefs.getInt("macro_btn_x", screen.x / 2 - size / 2);
            macroButtonParams.y = prefs.getInt("macro_btn_y", screen.y - size - dp(24));
            clamp(macroButtonParams, size, size);
            macroButton.setOnTouchListener(
                    new Dragger(macroButton, macroButtonParams, "macro_btn", this::onMacroButton) {
                @Override
                boolean onDown() {
                    // Pendant des clics automatiques, le « lever » du doigt n'arrive jamais.
                    if (!clicking && !macroRepeat && !macroFiring) return false;
                    onMacroButton();
                    return true;
                }
            });
            wm.addView(macroButton, macroButtonParams);
            updateTargetsTouchable();
        } catch (RuntimeException e) {
            App.logError(this, "Affichage de la macro", e);
            hideMacroTarget();
        }
    }

    private void hideMacroTarget() {
        stopMacroRepeat();
        removeQuietly(macroTarget);
        removeQuietly(macroButton);
        macroTarget = null;
        macroButton = null;
    }

    /** Bouton ⚡ : une rafale, ou marche / arrêt des rafales enchaînées (réglage). */
    private void onMacroButton() {
        if (Prefs.macroButtonMode(prefs) == Prefs.MACRO_BUTTON_CONTINUOUS) {
            if (macroRepeat) stopMacroRepeat();
            else startMacroRepeat();
        } else {
            fireMacro();
        }
    }

    private void startMacroRepeat() {
        if (macroTarget == null) return;
        macroRepeat = true;
        if (!macroFiring) fireMacro();
        refreshPanel();
    }

    private void stopMacroRepeat() {
        if (!macroRepeat) return;
        macroRepeat = false;
        handler.removeCallbacks(nextMacro);
        updateTargetsTouchable();
        if (!macroFiring) resumeClicking();
        refreshPanel();
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
        boolean wasTouchable = isTouchable(targetParams);
        clicking = true;
        session++;
        updateTargetsTouchable(); // sinon les clics tomberaient sur la cible elle-même
        nextBatchAt = SystemClock.uptimeMillis() + (wasTouchable ? FIRST_CLICK_DELAY_MS : 0);
        if (!macroFiring) handler.postAtTime(clickLoop, (long) nextBatchAt);
        refreshPanel();
    }

    private void stopClicking() {
        if (!clicking) return;
        clicking = false;
        handler.removeCallbacks(clickLoop);
        updateTargetsTouchable();
        refreshPanel();
    }

    /**
     * Rafale de clics sur la cible bleue (ex. split ×4 dans Agar.io), en un seul geste.
     * L'auto-clic en cours fait une pause le temps de la rafale : un nouveau geste annulerait
     * l'autre.
     */
    private void fireMacro() {
        if (macroTarget == null || macroFiring) return;
        int[] loc = new int[2];
        macroTarget.getLocationOnScreen(loc);
        float x = loc[0] + macroTarget.getWidth() / 2f;
        float y = loc[1] + macroTarget.getHeight() / 2f;
        boolean wasTouchable = isTouchable(macroParams);
        macroFiring = true;
        session++; // les paquets d'auto-clic encore en vol ne relancent plus la boucle
        handler.removeCallbacks(clickLoop);
        updateTargetsTouchable();
        refreshPanel();

        int taps = Prefs.macroTaps(prefs);
        int delay = Prefs.macroDelay(prefs);
        // Assez long pour qu'un jeu qui lit l'écran à chaque image voie chaque clic.
        long duration = Math.max(1, Math.min(30, delay / 2));
        Runnable send = () -> {
            if (!macroFiring) return;
            Path path = new Path();
            path.moveTo(x, y);
            GestureDescription.Builder gesture = new GestureDescription.Builder();
            for (int i = 0; i < taps; i++) {
                gesture.addStroke(new GestureDescription.StrokeDescription(path, (long) i * delay, duration));
            }
            boolean sent = dispatchGesture(gesture.build(), new GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription g) {
                    macroDone();
                }

                @Override
                public void onCancelled(GestureDescription g) {
                    macroDone();
                }
            }, handler);
            if (!sent) macroDone();
        };
        // Cible verrouillée : déjà traversable, la rafale part tout de suite.
        if (wasTouchable) handler.postDelayed(send, FIRST_CLICK_DELAY_MS);
        else send.run();
    }

    private void macroDone() {
        if (!macroFiring) return;
        macroFiring = false;
        if (macroRepeat) {
            // L'auto-clic reste en pause tant que les rafales s'enchaînent.
            handler.postDelayed(nextMacro, Prefs.macroDelay(prefs));
            return;
        }
        updateTargetsTouchable();
        refreshPanel();
        resumeClicking();
    }

    private void resumeClicking() {
        if (!clicking) return;
        nextBatchAt = SystemClock.uptimeMillis();
        scheduleNextBatch();
    }

    /**
     * Envoie `count` clics, un toutes les `intervalMs`, en un seul geste ; à chaque clic,
     * `fingers` doigts tapent ensemble autour du point (les jeux qui lisent l'écran une fois
     * par image comptent chaque doigt, au lieu de perdre les clics trop rapprochés).
     * Le paquet suivant part quand celui-ci est fini (ou interrompu par un vrai toucher).
     * @return false si Android a refusé le geste.
     */
    private boolean tapBurst(float x, float y, int fingers, int count, double intervalMs,
            long durationMs, int forSession) {
        Path[] paths = new Path[fingers];
        float spread = dp(4); // reste dans le bouton visé
        for (int f = 0; f < fingers; f++) {
            double angle = f == 0 ? 0 : 2 * Math.PI * (f - 1) / (fingers - 1);
            float r = f == 0 ? 0 : spread;
            paths[f] = new Path();
            paths[f].moveTo(x + r * (float) Math.cos(angle), y + r * (float) Math.sin(angle));
        }
        GestureDescription.Builder gesture = new GestureDescription.Builder();
        for (int i = 0; i < count; i++) {
            long start = Math.round(i * intervalMs);
            for (Path path : paths) {
                gesture.addStroke(new GestureDescription.StrokeDescription(path, start, durationMs));
            }
        }
        return dispatchGesture(gesture.build(), new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription g) {
                if (forSession == session) scheduleNextBatch();
            }

            @Override
            public void onCancelled(GestureDescription g) {
                if (forSession == session) scheduleNextBatch();
            }
        }, handler);
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

        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.HORIZONTAL);
        bottom.setPadding(0, dp(6), 0, 0);
        lockButton = roundText(dp(32), 14, COLOR_SMALL);
        onPress(lockButton, () -> {
            locked = !locked;
            updateTargetsTouchable();
            refreshPanel();
        });
        bottom.addView(lockButton);
        TextView close = roundText(dp(32), 15, COLOR_SMALL);
        close.setText("✕");
        onPress(close, this::hideOverlay);
        LinearLayout.LayoutParams closeLp = new LinearLayout.LayoutParams(dp(32), dp(32));
        closeLp.leftMargin = dp(4);
        bottom.addView(close, closeLp);
        root.addView(bottom);
        return root;
    }

    private void refreshPanel() {
        if (panel == null) return;
        int cps = Prefs.cps(prefs);
        int fingers = Prefs.fingers(prefs);
        speedLabel.setText(fingers > 1 ? cps + "/s\n×" + fingers : cps + "/s");
        if (macroButton != null) macroButton.setActive(macroRepeat || macroFiring);
        lockButton.setText(locked ? "🔒" : "🔓");
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

    /**
     * Une cible doit laisser passer les clics qu'on envoie dessus : on ne peut la toucher
     * (pour la déplacer) que quand elle ne reçoit rien et que les cibles ne sont pas verrouillées.
     */
    private void updateTargetsTouchable() {
        setTouchable(target, targetParams, !locked && !clicking);
        setTouchable(macroTarget, macroParams, !locked && !macroFiring && !macroRepeat);
    }

    private static boolean isTouchable(WindowManager.LayoutParams lp) {
        return (lp.flags & WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE) == 0;
    }

    private void setTouchable(View view, WindowManager.LayoutParams lp, boolean touchable) {
        if (view == null) return;
        view.setAlpha(touchable ? 1f : 0.7f);
        if (isTouchable(lp) == touchable) return;
        if (touchable) lp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        else lp.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        try {
            wm.updateViewLayout(view, lp);
        } catch (RuntimeException ignored) {
            // Fenêtre pas encore ajoutée ou déjà retirée.
        }
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
        if (macroTarget != null) moveProportionally(macroTarget, macroParams, placedFor, screen);
        if (macroButton != null) moveProportionally(macroButton, macroButtonParams, placedFor, screen);
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
