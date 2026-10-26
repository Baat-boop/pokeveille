package fr.pokeveille.autoclicker;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.View;

/** Cible flottante : son centre est l'endroit où les clics sont envoyés. */
final class TargetView extends View {
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint outline = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final float density;

    TargetView(Context context) {
        super(context);
        density = context.getResources().getDisplayMetrics().density;
        fill.setColor(0x55E53935);
        outline.setStyle(Paint.Style.STROKE);
        outline.setColor(0xFFFFFFFF);
        outline.setStrokeWidth(5 * density);
        ring.setStyle(Paint.Style.STROKE);
        ring.setColor(0xFFE53935);
        ring.setStrokeWidth(2.5f * density);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float cx = getWidth() / 2f;
        float cy = getHeight() / 2f;
        float r = Math.min(cx, cy) - 4 * density;
        float arm = r * 0.55f;

        canvas.drawCircle(cx, cy, r, fill);
        // Contour blanc sous le rouge : la cible reste visible sur fond clair comme sombre.
        canvas.drawCircle(cx, cy, r, outline);
        canvas.drawCircle(cx, cy, r, ring);
        canvas.drawLine(cx - arm, cy, cx + arm, cy, outline);
        canvas.drawLine(cx, cy - arm, cx, cy + arm, outline);
        canvas.drawLine(cx - arm, cy, cx + arm, cy, ring);
        canvas.drawLine(cx, cy - arm, cx, cy + arm, ring);
    }
}
