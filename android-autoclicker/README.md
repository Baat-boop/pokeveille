# Auto-clicker Android

Petite application Android (sans pub, sans Internet, sans root) qui clique à votre place à l'endroit d'une cible.

- **Puissance réglable** : de 1 à 50 clics par seconde (curseur dans l'appli, ou − / + sur le panneau flottant, même pendant que ça clique).
- **Bouton flottant** simple : ▶ démarre, ■ arrête.
- **Deux modes de mise en marche** :
  - *1 appui = marche, 1 appui = arrêt* : bouton flottant **ou** touche de volume ;
  - *Clique tant que le bouton est maintenu* : maintenez la touche de volume choisie (Volume − par défaut), relâchez pour arrêter.

> Pourquoi le mode maintien passe par une touche de volume : Android annule le doigt posé sur l'écran
> à chaque clic automatique. Un bouton **à l'écran** ne peut donc pas être « maintenu » pendant que
> l'appli clique ; une touche physique, si.

## Installer

1. Sur le téléphone, ouvrez
   **https://github.com/baat-boop/pokeveille/releases/download/autoclicker-latest/AutoClicker.apk**
   (l'APK est recompilé automatiquement à chaque modification du dossier `android-autoclicker/`).
2. Ouvrez le fichier téléchargé → autorisez l'installation depuis le navigateur si Android le demande.
3. Lancez **Auto-clicker** → **Activer dans Accessibilité** → *Applications installées / téléchargées* → **Auto-clicker** → activer.
   - **Android 13 et plus** : si l'interrupteur est grisé (« paramètre restreint »), ouvrez les infos de l'appli
     (bouton dans l'appli), menu **⋮** en haut à droite → **Autoriser les paramètres restreints**, puis recommencez.

L'accessibilité est la seule autorisation demandée : c'est elle qui permet de toucher l'écran et d'afficher
le panneau flottant. L'appli ne lit pas le contenu de l'écran et n'a pas accès à Internet.

## Utiliser

1. Réglez la puissance, le mode et la touche physique dans l'appli.
2. **Afficher le bouton flottant** : l'appli passe en arrière-plan, ouvrez le jeu / l'appli à cliquer.
3. Glissez la **cible 🎯** sur l'endroit à cliquer ; glissez le gros bouton pour déplacer le panneau.
4. ▶ (ou la touche de volume) pour démarrer ; ■ (ou la touche) pour arrêter. **✕** ferme le panneau.

Tant que le panneau est affiché, la touche choisie commande l'auto-clicker au lieu du volume.
Les clics s'arrêtent aussi automatiquement quand l'écran s'éteint.

## Compiler soi-même

Android Studio : ouvrir le dossier `android-autoclicker/`. En ligne de commande (Gradle 8.9+, SDK Android 35) :

```bash
cd android-autoclicker && gradle assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

La clé de signature `app/autoclicker.keystore` est volontairement dans le dépôt (application personnelle,
hors Play Store) : chaque nouvelle version s'installe par-dessus l'ancienne sans désinstaller.
