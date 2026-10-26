package fr.pokeveille.autoclicker;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private SharedPreferences prefs;
    private TextView serviceStatus;
    private Button serviceOpen;
    private TextView powerValue;
    private SeekBar powerSeek;
    private RadioButton keyNone;
    private Button overlayToggle;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        prefs = Prefs.get(this);

        serviceStatus = findViewById(R.id.service_status);
        serviceOpen = findViewById(R.id.service_open);
        serviceOpen.setOnClickListener(v ->
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        findViewById(R.id.service_app_info).setOnClickListener(v ->
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", getPackageName(), null))));

        powerValue = findViewById(R.id.power_value);
        powerSeek = findViewById(R.id.power_seek);
        powerSeek.setMax(Prefs.MAX_CPS - Prefs.MIN_CPS);
        powerSeek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                if (fromUser) setCps(Prefs.MIN_CPS + progress);
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {}

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {}
        });
        findViewById(R.id.power_minus).setOnClickListener(v -> setCps(Prefs.cps(prefs) - 1));
        findViewById(R.id.power_plus).setOnClickListener(v -> setCps(Prefs.cps(prefs) + 1));

        RadioGroup modeGroup = findViewById(R.id.mode_group);
        modeGroup.check(Prefs.mode(prefs) == Prefs.MODE_HOLD ? R.id.mode_hold : R.id.mode_toggle);
        modeGroup.setOnCheckedChangeListener((group, id) -> {
            int mode = id == R.id.mode_hold ? Prefs.MODE_HOLD : Prefs.MODE_TOGGLE;
            SharedPreferences.Editor edit = prefs.edit().putInt(Prefs.KEY_MODE, mode);
            // Le maintien passe forcément par une touche physique.
            if (mode == Prefs.MODE_HOLD && Prefs.hwKey(prefs) == Prefs.HW_NONE) {
                edit.putInt(Prefs.KEY_HW, Prefs.HW_VOL_DOWN);
            }
            edit.apply();
            refresh();
        });

        RadioGroup keyGroup = findViewById(R.id.key_group);
        keyNone = findViewById(R.id.key_none);
        int hw = Prefs.hwKey(prefs);
        keyGroup.check(hw == Prefs.HW_VOL_UP ? R.id.key_vol_up
                : hw == Prefs.HW_NONE ? R.id.key_none : R.id.key_vol_down);
        keyGroup.setOnCheckedChangeListener((group, id) -> {
            int key = id == R.id.key_vol_up ? Prefs.HW_VOL_UP
                    : id == R.id.key_none ? Prefs.HW_NONE : Prefs.HW_VOL_DOWN;
            prefs.edit().putInt(Prefs.KEY_HW, key).apply();
        });

        findViewById(R.id.error_copy).setOnClickListener(v -> {
            String error = App.lastError(this);
            if (error == null) return;
            getSystemService(ClipboardManager.class)
                    .setPrimaryClip(ClipData.newPlainText("Erreur Auto-clicker", error));
            Toast.makeText(this, R.string.error_copied, Toast.LENGTH_SHORT).show();
        });
        findViewById(R.id.error_clear).setOnClickListener(v -> {
            App.clearError(this);
            refresh();
        });

        overlayToggle = findViewById(R.id.overlay_toggle);
        overlayToggle.setOnClickListener(v -> toggleOverlay());
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    private void setCps(int cps) {
        prefs.edit().putInt(Prefs.KEY_CPS, Prefs.clampCps(cps)).apply();
        refresh();
    }

    private void toggleOverlay() {
        ClickService service = ClickService.get();
        if (service == null) {
            Toast.makeText(this, R.string.toast_need_service, Toast.LENGTH_LONG).show();
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            return;
        }
        if (service.isOverlayShown()) {
            service.hideOverlay();
            refresh();
        } else if (service.showOverlay()) {
            moveTaskToBack(true); // retour à l'appli à cliquer
        } else {
            Toast.makeText(this, R.string.toast_overlay_failed, Toast.LENGTH_LONG).show();
            refresh();
        }
    }

    private void refresh() {
        ClickService service = ClickService.get();
        boolean enabled = service != null;
        boolean stalled = !enabled && isEnabledInSettings();
        serviceStatus.setText(enabled ? R.string.service_on
                : stalled ? R.string.service_not_running : R.string.service_off);
        serviceOpen.setVisibility(enabled ? View.GONE : View.VISIBLE);
        boolean restrictedPossible = !enabled && !stalled
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU;
        findViewById(R.id.service_restricted_help).setVisibility(restrictedPossible ? View.VISIBLE : View.GONE);
        findViewById(R.id.service_app_info).setVisibility(enabled ? View.GONE : View.VISIBLE);

        String error = App.lastError(this);
        findViewById(R.id.error_box).setVisibility(error != null ? View.VISIBLE : View.GONE);
        ((TextView) findViewById(R.id.error_text)).setText(error);

        int cps = Prefs.cps(prefs);
        powerValue.setText(getString(R.string.power_value, cps, 1000 / cps));
        powerSeek.setProgress(cps - Prefs.MIN_CPS);

        boolean hold = Prefs.mode(prefs) == Prefs.MODE_HOLD;
        findViewById(R.id.mode_hold_help).setVisibility(hold ? View.VISIBLE : View.GONE);
        keyNone.setEnabled(!hold);
        if (hold && keyNone.isChecked()) ((RadioGroup) findViewById(R.id.key_group)).check(R.id.key_vol_down);

        overlayToggle.setText(enabled && service.isOverlayShown()
                ? R.string.overlay_hide : R.string.overlay_show);
    }

    /** Coché dans Accessibilité, qu'Android ait réussi à démarrer le service ou non. */
    private boolean isEnabledInSettings() {
        String list = Settings.Secure.getString(getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (list == null) return false;
        ComponentName self = new ComponentName(this, ClickService.class);
        for (String entry : list.split(":")) {
            if (self.equals(ComponentName.unflattenFromString(entry))) return true;
        }
        return false;
    }
}
