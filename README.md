# PokéVeille — veille gratuite des cartes Pokémon (Amiens)

Application personnelle qui :

- relève **toutes les ~15 minutes** le stock réel de boutiques en ligne Pokémon qui livrent en France ;
- relaie les **bons plans Dealabs** (Fnac, Leclerc, Carrefour, Amazon…) — signalés par la communauté, stock non vérifié ;
- liste les **magasins d'Amiens accessibles en bus Ametis** (adresse, distance, arrêt, lignes) — stock en rayon non vérifiable ;
- envoie une **alerte Discord** quand un produit surveillé revient en stock ou qu'une nouvelle offre disponible correspond à une recherche, **sans répéter** les alertes pour une offre inchangée.

Coût : 0 €. Tout tourne sur GitHub (Actions + Pages, gratuits pour un dépôt public), même ordinateur éteint.

- Tableau de bord : https://baat-boop.github.io/pokeveille/
- Lancer une vérification à la main : onglet **Actions** → « Vérification des stocks » → **Run workflow**

## Connecter Discord (une seule fois, ~3 min)

1. Dans Discord : bouton **+** (à gauche) → **Créer le mien** → **Pour moi et mes amis** → nommez le serveur (ex. « PokéVeille »).
2. Sur le salon `#général` : roue ⚙️ **Modifier le salon** → **Intégrations** → **Webhooks** → **Nouveau webhook** → **Copier l'URL du webhook**.
3. Sur GitHub, dans ce dépôt : **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
   - Name : `DISCORD_WEBHOOK_URL`
   - Secret : collez l'URL copiée → **Add secret**.
4. Installez l'application Discord sur votre téléphone et laissez les notifications activées pour ce serveur.

Ne partagez jamais cette URL : quiconque la possède peut écrire dans votre salon. (Si elle fuit : supprimez le webhook dans Discord et recommencez.)

## Utilisation

- **Offres** : filtres par mots-clés (nom, extension, code ME05…), type (ETB, display, coffret, booster, carte), langue, prix max, boutique, promotions, disponibilité.
- **Magasins** : saisissez votre adresse (elle reste dans votre navigateur), un rayon et la marche maximale depuis l'arrêt de bus.
- **Mes recherches** : créez / modifiez vos recherches, puis **Enregistrer sur GitHub** (copier → ouvrir l'éditeur → coller → *Commit changes*).
- **Alertes** : historique des alertes envoyées. **État** : santé de chaque source.

### Règles des alertes

| Situation | Alerte ? |
|---|---|
| Produit en rupture → disponible (ou précommande) | 🟢 Oui, « Retour en stock » |
| Nouveau produit déjà disponible qui correspond | 🆕 Oui, « Nouvelle offre » |
| Nouveau bon plan Dealabs qui correspond | 💡 Oui, « Bon plan signalé » |
| Produit référencé mais pas encore commandable | 📣 Oui, puis alerte dès qu'il devient commandable |
| Prix en baisse d'au moins 10 % depuis la dernière alerte | 📉 Oui, « Baisse de prix » (désactivable par recherche) |
| Offre inchangée, ou petite variation de prix | Non |
| Rupture puis retour en moins d'une heure | Retenue, envoyée si toujours dispo après 1 h |
| Boutique injoignable | Pas d'alerte de stock (dernier statut gardé, marqué « non actualisé ») ; ⚠️ un avertissement si ça dure 3 h, ✅ un message quand elle répond |
| Plus aucune vérification depuis 2 h (panne, GitHub qui saute des passages) | ⚠️ Un avertissement (workflow « Surveillance » séparé, toutes les heures), ✅ un message à la reprise |

Prix de référence (`config/prices.json`) : pour les produits français standard du bloc Méga-Évolution et les sorties du calendrier, les offres à 30 % ou plus au-dessus du prix le plus cité par les sites spécialisés sont signalées (site et Discord). Il n'existe pas de prix conseillé officiel en euros.
| Nouvelle recherche / critères modifiés / nouvelle boutique | Un seul récapitulatif, puis alertes normales |

## Sources et limites (honnêtement)

| Source | Ce qui est vérifié |
|---|---|
| Pokémania, Sneyzen Corp, Hikaru Distribution, LeShiny | Stock et prix réels via leur catalogue public (`/products.json`), robots.txt et conditions d'utilisation respectés, 2 s entre requêtes |
| VCOLLECT, PokeStation | **Exclues** : leurs conditions d'utilisation interdisent l'exploration automatique |
| Dealabs (flux RSS Pokémon) | Bons plans postés par la communauté : **pas** de stock vérifié |
| Magasins physiques (OpenStreetMap + GTFS Ametis) | Découverte uniquement : **pas** de stock |

Non couverts : Fnac, Cultura, Leclerc, Carrefour, Auchan, King Jouet, Micromania, Amazon… Leurs sites bloquent les robots ou interdisent l'extraction automatique, et leurs API sont privées ou payantes. L'application ne contourne aucune protection. Pour ces enseignes, les bons plans Dealabs et les alertes intégrées des enseignes sont les alternatives gratuites.

Ajouter une boutique : si elle tourne sous Shopify (adresse `/products.json` qui répond) ou WooCommerce (Store API autorisée par son robots.txt), ajoutez-la dans `config/sources.json`.

GitHub : les passages planifiés peuvent être **retardés de quelques minutes à ~1 h** aux heures chargées, voire sautés ; ce n'est pas un service temps réel garanti. Un dépôt public sans activité pendant 60 jours voit ses tâches planifiées suspendues ; la maintenance mensuelle (commit automatique) l'évite. Si cela arrive quand même : onglet Actions → « Enable workflow ».

## Développement

```
npm test                      # tests (filtres, retours en stock, anti-doublons…)
node src/check.js --data .data-local   # un passage en local (sans webhook : aucune alerte envoyée)
node tools/serve.mjs          # aperçu sur http://localhost:8080/docs/?local
```
