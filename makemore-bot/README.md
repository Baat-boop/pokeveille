# Bot Make More! — il joue tout seul, sur ton téléphone

Le bot tourne **dans Termux, sur le téléphone lui-même** (pas besoin de PC). Il passe par le *débogage sans fil* d'Android pour :

- regarder l'écran (captures d'écran) ;
- **taper** sur la zone de production en continu ;
- **acheter** les améliorations ou embauches dès que leur bouton est disponible (il reconnaît la couleur du bouton) ;
- **fermer** les fenêtres (récompenses, boss…) ;
- **relancer** le jeu s'il se ferme ou si une pub ouvre une autre appli.

Sécurités :

- Il ne tape **que** s'il voit le *repère* de l'écran principal. Dans un menu ou une boutique, il ne tape rien et appuie sur Retour.
- Si une fenêtre d'achat Google Play s'ouvre, il appuie sur Retour et ne touche à rien dedans : **jamais d'achat avec de l'argent réel**.
- **Touche l'écran toi-même** : le bot se met en pause 20 s, le temps que tu joues.

Il faut Android 11 ou plus récent (pour le débogage sans fil) et le Wi-Fi allumé (pas besoin d'internet, juste être connecté à un réseau).

## 1. Installer (une fois)

1. Installe **Termux** depuis [F-Droid](https://f-droid.org/packages/com.termux/) (la version du Play Store est périmée).
2. Dans Termux, colle :

   ```sh
   pkg install -y python android-tools
   curl -fsSLo makemore_bot.py https://raw.githubusercontent.com/baat-boop/pokeveille/main/makemore-bot/makemore_bot.py
   ```

## 2. Connecter (une fois, puis automatique)

```sh
python makemore_bot.py connecter
```

et suis les étapes : activer les *Options pour les développeurs* (7 touches sur « Numéro de build »), puis *Débogage sans fil*, puis *Associer l'appareil avec un code d'association*. Mets Termux et les Paramètres en **écran partagé**, sinon le code disparaît dès que tu changes d'appli.

Après un redémarrage, il suffit de réactiver *Débogage sans fil*. Le bot retrouve tout seul le nouveau port (sinon il te le demande).

## 3. Régler (une fois)

```sh
python makemore_bot.py regler
```

Le bot ne connaît pas l'écran du jeu à l'avance. Tu lui montres les éléments en les touchant. Pour chaque point : choisis-le dans le menu, va dans le jeu dans les 40 s et touche l'élément. Le téléphone vibre quand c'est enregistré, puis reviens dans Termux.

| Choix | Quoi toucher |
|---|---|
| 1. Zone à taper | L'endroit où l'on tape pour produire. Tu peux en mettre plusieurs. |
| 2. **Repère** (obligatoire) | Un élément fixe de l'écran principal qui ne bouge pas et ne fait rien, par exemple l'icône de pièce à côté de ton argent. |
| 3. Bouton à acheter | Un bouton d'amélioration ou d'embauche, **pendant qu'il est disponible** (de la bonne couleur). Le bot l'achètera à chaque fois qu'il le reverra de cette couleur. |
| 4. Bouton fermer | Fais d'abord apparaître la fenêtre, puis touche sa croix ou son bouton « récupérer ». |
| 6. Tester | Montre ce que le bot reconnaît sur l'écran, maintenant. |

## 4. Jouer

```sh
termux-wake-lock          # empêche Android d'endormir Termux
python makemore_bot.py jouer
```

Ouvre ensuite le jeu et laisse faire. Le bot écrit un bilan dans Termux toutes les minutes. Pour l'arrêter : **Ctrl+C** dans Termux. Pour l'arrêter tout seul après 2 heures : `python makemore_bot.py jouer --minutes 120`.

Conseils : laisse le téléphone branché, et dans les paramètres de la batterie, mets Termux en « Non restreint ».

## Réglages fins

Ils sont dans `makemore_config.json`, à côté du script :

| Clé | Par défaut | Rôle |
|---|---|---|
| `tolerance` | 28 | Écart de couleur accepté (0–255). Augmente-le si le bot ne reconnaît pas un bouton (option 6), baisse-le s'il en confond. |
| `taps_per_second` | 4 | Vitesse de tapotage sur la zone. |
| `burst_seconds` | 2.5 | Durée de tapotage entre deux regards sur l'écran. |
| `pause_on_touch_seconds` | 20 | Durée de la pause quand tu touches l'écran. |

## Si ça ne marche pas

- **« Pas de téléphone connecté »** : réactive *Débogage sans fil* et relance. Le Wi-Fi doit être allumé.
- **Le bot appuie sans arrêt sur Retour** : il ne reconnaît plus le repère. Refais-le (option 5 pour supprimer, puis option 2) sur un élément qui ne change jamais.
- **Il n'achète jamais un bouton** : utilise l'option 6 pendant que le bouton est disponible. Si la couleur est proche mais refusée, augmente `tolerance`.
- **Mode sombre, changement de thème ou mise à jour du jeu** : les couleurs changent, il faut refaire le réglage.
