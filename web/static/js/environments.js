// Map environments: the land around the city, and what separates services
// inside the Docker host or cluster from those outside it.
//
//   border  what lies between the two sides when there are both:
//           river  - a river (frozen, in winter)
//           canyon - a dry gorge
//           ridge  - a two-row mountain range, crossed by a pass
//           sea    - open water; each side is its own island
//   river   a river runs through (or beside) the city as well
//   lakes   the city gets a lake
//   decor   what fills the empty land: peaks (snowy in winter), mesas, or nothing
//   trees   tree sprites to pick from on each bank (see treeSprite), and
//           rockTree for rocky ground under the peaks
//   colors  overrides of the ground palette in city.js
//   sky     top and horizon colours behind the side panel's building preview

// Tree sprite variants.
export const TREE = { ROUND: 0, BUSH: 1, PINE: 2, PALM: 3, CACTUS: 4, SNOWY_PINE: 5, SHRUB: 6 };

export const ENVIRONMENTS = {
  suburban: {
    border: 'river',
    river: true,
    lakes: true,
    trees: [TREE.ROUND, TREE.BUSH, TREE.PINE],
    farTrees: [TREE.PINE, TREE.PINE, TREE.ROUND, TREE.BUSH, TREE.PINE],
    sky: ['#7fb6e6', '#bfe0f5'],
    colors: {},
  },
  mountains: {
    border: 'ridge',
    river: true,
    lakes: true,
    decor: { kind: 'alpine', chance: 0.45 },
    trees: [TREE.PINE, TREE.PINE, TREE.PINE, TREE.ROUND],
    farTrees: [TREE.PINE, TREE.PINE, TREE.SNOWY_PINE],
    sky: ['#6a9fd8', '#d3e5f3'],
    colors: {
      grass: '#4f8a46',
      grassDark: '#437a3c',
      grassLight: '#5f9a52',
      farGrass: '#6a8c5c',
      farGrassDark: '#5c7d50',
      farGrassLight: '#7a9c6a',
      park: '#5a9a4c',
      parkStripe: '#529145',
      deep: '#2c5f8f',
    },
  },
  islands: {
    border: 'sea',
    river: false,
    lakes: false,
    beach: 0.9, // how far inland the sand reaches, in tiles
    trees: [TREE.PALM, TREE.PALM, TREE.ROUND, TREE.BUSH],
    farTrees: [TREE.PALM, TREE.PALM, TREE.PALM, TREE.BUSH],
    sky: ['#3fa9e6', '#bdeaf7'],
    colors: {
      grass: '#5fae4a',
      grassDark: '#519c3f',
      grassLight: '#72bf58',
      farGrass: '#6fb04c',
      farGrassDark: '#5f9e41',
      farGrassLight: '#82c05c',
      bank: '#e6d59c',
      bankDark: '#d3c186',
      shallow: '#62d2d0',
      water: '#2fa3c8',
      deep: '#21769f',
      glint: '#c4f1f4',
      dirt: '#c9b27c',
      dirtDark: '#b09a66',
      rock: '#8c7a5c',
    },
  },
  desert: {
    border: 'canyon',
    river: true, // as a canyon
    lakes: true, // oases
    decor: { kind: 'mesa', chance: 0.4 },
    trees: [TREE.CACTUS, TREE.CACTUS, TREE.SHRUB],
    rockTree: TREE.SHRUB,
    farTrees: [TREE.CACTUS, TREE.SHRUB, TREE.SHRUB],
    sky: ['#76b3de', '#f2dcb0'], // a hazy, sun-bleached horizon
    colors: {
      grass: '#d9b26f',
      grassDark: '#c9a05e',
      grassLight: '#e6c483',
      farGrass: '#cf9c62',
      farGrassDark: '#bf8b53',
      farGrassLight: '#ddb077',
      park: '#8fb35a',
      parkStripe: '#84a852',
      bank: '#c9a466',
      bankDark: '#b48f55',
      scree: '#b0704a',
      screeDark: '#955b3a',
      dirt: '#b8794a',
      dirtDark: '#9a613a',
      rock: '#7d4d30',
    },
  },
  winter: {
    border: 'river', // frozen
    river: true,
    lakes: true,
    decor: { kind: 'snowy', chance: 0.3 },
    trees: [TREE.SNOWY_PINE, TREE.SNOWY_PINE, TREE.PINE],
    rockTree: TREE.SNOWY_PINE,
    farTrees: [TREE.SNOWY_PINE, TREE.SNOWY_PINE, TREE.SNOWY_PINE, TREE.PINE],
    sky: ['#8fa3b8', '#c3d1de'], // overcast
    colors: {
      grass: '#e9eef3',
      grassDark: '#d6dfe8',
      grassLight: '#f7fafc',
      farGrass: '#dde5ee',
      farGrassDark: '#cad5e1',
      farGrassLight: '#eef3f8',
      park: '#e3eaf0',
      parkStripe: '#d9e2ea',
      bank: '#c7d2dc',
      bankDark: '#b6c3cf',
      shallow: '#b4d8ee',
      water: '#93c3e3',
      deep: '#78afd6',
      glint: '#ffffff',
      foam: '#ffffff',
      scree: '#9ba7b3',
      screeDark: '#86929f',
    },
  },
};

export const DEFAULT_ENVIRONMENT = 'suburban';

export function environment(name) {
  return ENVIRONMENTS[name] || ENVIRONMENTS[DEFAULT_ENVIRONMENT];
}
