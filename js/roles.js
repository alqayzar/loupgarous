// Ajouter un rôle ici suffit pour qu'il apparaisse dans les paramètres.
export const ROLES = [
  {
    id: 'villager',
    name: 'Villageois',
    description: 'Un habitant du village sans pouvoir.',
    color: '#6380C2',
    required: true,
    icon: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  },
  {
    id: 'wolf',
    name: 'Loup Garou',
    description: 'Élimine les villageois chaque nuit.',
    color: '#DE3C4B',
    required: true,
    icon: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z',
  },
  {
    id: 'witch',
    name: 'Sorcière',
    description: 'Possède une potion de vie et une de mort.',
    color: '#2CB585',
    required: false,
    icon: 'M12 2l2.65 8.16H23l-6.96 5.06 2.65 8.16L12 18.32l-6.69 4.06 2.65-8.16L2 10.16h8.35z',
  },
];
