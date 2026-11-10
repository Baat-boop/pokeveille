package fr.pokeveille.autoclicker;

import android.content.Context;
import android.content.SharedPreferences;
import android.view.KeyEvent;

/** Réglages partagés entre l'écran principal et le service. */
final class Prefs {
    static final String KEY_CPS = "cps";
    static final String KEY_MODE = "mode";
    static final String KEY_HW = "hw_key";
    static final String KEY_FINGERS = "fingers";
    static final String KEY_MACRO_ON = "macro_on";
    static final String KEY_MACRO_TAPS = "macro_taps";
    static final String KEY_MACRO_DELAY = "macro_delay";
    static final String KEY_MACRO_BUTTON_MODE = "macro_button_mode";

    static final int MODE_TOGGLE = 0;
    static final int MODE_HOLD = 1;

    static final int HW_NONE = 0;
    static final int HW_VOL_DOWN = 1;
    static final int HW_VOL_UP = 2;

    static final int MIN_CPS = 1;
    static final int MAX_CPS = 500;
    static final int DEFAULT_CPS = 10;

    static final int MAX_FINGERS = 10;

    static final int MIN_MACRO_TAPS = 2;
    static final int MAX_MACRO_TAPS = 10;
    static final int MIN_MACRO_DELAY = 10;
    static final int MAX_MACRO_DELAY = 300;
    static final int MACRO_DELAY_STEP = 10;

    static final int MACRO_BUTTON_SINGLE = 0;
    static final int MACRO_BUTTON_CONTINUOUS = 1;

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

    /** Nombre de doigts qui tapent en même temps à chaque clic. */
    static int fingers(SharedPreferences p) {
        return clampFingers(p.getInt(KEY_FINGERS, 1));
    }

    static int clampFingers(int fingers) {
        return Math.max(1, Math.min(MAX_FINGERS, fingers));
    }

    static boolean macroOn(SharedPreferences p) {
        return p.getBoolean(KEY_MACRO_ON, false);
    }

    /** Nombre de clics de la rafale (ex. 4 = « 16 morceaux » dans Agar.io). */
    static int macroTaps(SharedPreferences p) {
        return clampMacroTaps(p.getInt(KEY_MACRO_TAPS, 4));
    }

    static int clampMacroTaps(int taps) {
        return Math.max(MIN_MACRO_TAPS, Math.min(MAX_MACRO_TAPS, taps));
    }

    /** Délai entre deux clics de la rafale, en ms. */
    static int macroDelay(SharedPreferences p) {
        return clampMacroDelay(p.getInt(KEY_MACRO_DELAY, 50));
    }

    static int clampMacroDelay(int ms) {
        return Math.max(MIN_MACRO_DELAY, Math.min(MAX_MACRO_DELAY, ms));
    }

    /** Bouton ⚡ : une rafale par appui, ou rafales enchaînées jusqu'au prochain appui. */
    static int macroButtonMode(SharedPreferences p) {
        return p.getInt(KEY_MACRO_BUTTON_MODE, MACRO_BUTTON_CONTINUOUS);
    }

    /** Touche de la macro : l'autre touche de volume que celle de l'auto-clicker. */
    static int macroKeyCode(SharedPreferences p) {
        return hwKey(p) == HW_VOL_UP ? KeyEvent.KEYCODE_VOLUME_DOWN : KeyEvent.KEYCODE_VOLUME_UP;
    }

    static String macroKeyLabel(Context context, SharedPreferences p) {
        return context.getString(macroKeyCode(p) == KeyEvent.KEYCODE_VOLUME_UP
                ? R.string.key_vol_up : R.string.key_vol_down);
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
