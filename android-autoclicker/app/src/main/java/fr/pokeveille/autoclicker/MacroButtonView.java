package fr.pokeveille.autoclicker;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;

/**
 * Bouton flottant de la macro, dans le style des boutons d'action des jeux .io :
 * disque sombre translucide, viseur blanc et éclair au centre. Orange quand la macro tourne.
 */
final class MacroButtonView extends View {
    private final Paint disc = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint rim = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint sight = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint bolt = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path boltPath = new Path();
    private final float density;
    private boolean active;

    MacroButtonView(Context context) {
        super(context);
        density = context.getResources().getDisplayMetrics().density;
        rim.setStyle(Paint.Style.STROKE);
        rim.setStrokeWidth(2 * density);
        sight.setStyle(Paint.Style.STROKE);
        sight.setColor(0xFFFFFFFF);
        sight.setStrokeWidth(3 * density);
        sight.setStrokeCap(Paint.Cap.ROUND);
        bolt.setColor(0xFFFFFFFF);
        bolt.setStyle(Paint.Style.FILL);
        setActive(false);
    }

    void setActive(boolean active) {
        this.active = active;
        disc.setColor(active ? 0x88EF6C00 : 0x66000000);
        rim.setColor(active ? 0xFFEF6C00 : 0x88FFFFFF);
        invalidate();
    }

    boolean isActive() {
        return active;
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float cx = getWidth() / 2f;
        float cy = getHeight() / 2f;
        float r = Math.min(cx, cy) - 2 * density;
        canvas.drawCircle(cx, cy, r, disc);
        canvas.drawCircle(cx, cy, r, rim);

        // Viseur : cercle et quatre traits qui le traversent.
        float ring = r * 0.5f;
        canvas.drawCircle(cx, cy, ring, sight);
        float in = r * 0.32f;
        float out = r * 0.72f;
        canvas.drawLine(cx, cy - out, cx, cy - in, sight);
        canvas.drawLine(cx, cy + in, cx, cy + out, sight);
        canvas.drawLine(cx - out, cy, cx - in, cy, sight);
        canvas.drawLine(cx + in, cy, cx + out, cy, sight);

        // Éclair au centre.
        float s = r * 0.42f;
        boltPath.reset();
        boltPath.moveTo(cx + 0.12f * s, cy - 0.62f * s);
        boltPath.lineTo(cx - 0.32f * s, cy + 0.08f * s);
        boltPath.lineTo(cx - 0.02f * s, cy + 0.08f * s);
        boltPath.lineTo(cx - 0.14f * s, cy + 0.62f * s);
        boltPath.lineTo(cx + 0.32f * s, cy - 0.08f * s);
        boltPath.lineTo(cx + 0.02f * s, cy - 0.08f * s);
        boltPath.close();
        canvas.drawPath(boltPath, bolt);
    }
}
