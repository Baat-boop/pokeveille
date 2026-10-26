package fr.pokeveille.autoclicker;

import android.content.Context;
import android.content.SharedPreferences;
import android.view.KeyEvent;

/** Réglages partagés entre l'écran principal et le service. */
final class Prefs {
    static final String KEY_CPS = "cps";
    static final String KEY_MODE = "mode";
    static final String KEY_HW = "hw_key";

    static final int MODE_TOGGLE = 0;
    static final int MODE_HOLD = 1;

    static final int HW_NONE = 0;
    static final int HW_VOL_DOWN = 1;
    static final int HW_VOL_UP = 2;

    static final int MIN_CPS = 1;
    static final int MAX_CPS = 500;
    static final int DEFAULT_CPS = 10;

    /** Crans du curseur et des boutons − / + : fins en bas, larges en haut. */
    static final int[] CPS_STEPS = {
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80,
            100, 120, 150, 200, 250, 300, 400, 500};

    private Prefs() {}

    static SharedPreferences get(Context context) {
        return context.getSharedPreferences("autoclicker", Context.MODE_PRIVATE);
    }

    static int cps(SharedPreferences p) {
        return clampCps(p.getInt(KEY_CPS, DEFAULT_CPS));
    }

    static int mode(SharedPreferences p) {
        return p.getInt(KEY_MODE, MODE_TOGGLE);
    }

    static int hwKey(SharedPreferences p) {
        return p.getInt(KEY_HW, HW_VOL_DOWN);
    }

    /** Code Android de la touche physique choisie, 0 si aucune. */
    static int hwKeyCode(SharedPreferences p) {
        switch (hwKey(p)) {
            case HW_VOL_DOWN: return KeyEvent.KEYCODE_VOLUME_DOWN;
            case HW_VOL_UP: return KeyEvent.KEYCODE_VOLUME_UP;
            default: return 0;
        }
    }

    static String hwKeyLabel(Context context, SharedPreferences p) {
        return context.getString(hwKey(p) == HW_VOL_UP ? R.string.key_vol_up : R.string.key_vol_down);
    }

    static int clampCps(int cps) {
        return Math.max(MIN_CPS, Math.min(MAX_CPS, cps));
    }

    /** Index du plus grand cran inférieur ou égal à cps. */
    static int stepIndex(int cps) {
        int i = 0;
        while (i + 1 < CPS_STEPS.length && CPS_STEPS[i + 1] <= cps) i++;
        return i;
    }

    static int stepUp(int cps) {
        return CPS_STEPS[Math.min(stepIndex(cps) + 1, CPS_STEPS.length - 1)];
    }

    static int stepDown(int cps) {
        int i = stepIndex(cps);
        // Une valeur entre deux crans (ancienne version) redescend d'abord au cran inférieur.
        return CPS_STEPS[CPS_STEPS[i] < cps ? i : Math.max(i - 1, 0)];
    }
}
