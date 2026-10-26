package fr.pokeveille.autoclicker;

import android.app.Application;
import android.content.Context;
import android.os.Build;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Garde la trace du dernier plantage pour l'afficher dans l'appli : sans câble ni outils
 * de développement, c'est le seul moyen de savoir pourquoi le service s'est arrêté.
 */
public class App extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            logError(this, "Plantage", error);
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }

    static void logError(Context context, String where, Throwable error) {
        StringWriter trace = new StringWriter();
        error.printStackTrace(new PrintWriter(trace));
        String text = where + " — " + Build.MANUFACTURER + " " + Build.MODEL
                + ", Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")\n"
                + trace;
        try (FileOutputStream out = new FileOutputStream(errorFile(context))) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            // Rien de mieux à faire si même l'écriture échoue.
        }
    }

    static String lastError(Context context) {
        try {
            File f = errorFile(context);
            return f.exists() ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8) : null;
        } catch (Exception e) {
            return null;
        }
    }

    static void clearError(Context context) {
        //noinspection ResultOfMethodCallIgnored
        errorFile(context).delete();
    }

    private static File errorFile(Context context) {
        return new File(context.getFilesDir(), "last_error.txt");
    }
}
