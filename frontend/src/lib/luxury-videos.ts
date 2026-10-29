// ==========================================================
// VISUELS CINÉMATIQUES PARTAGÉS
// ==========================================================
//
// Chaque visuel associe :
//   - une vidéo MP4 distante (Pexels) ;
//   - une image poster servie LOCALEMENT depuis /public/media.
//
// Le poster local est essentiel : il s'affiche immédiatement,
// sans dépendre du réseau. Si la vidéo distante est lente,
// bloquée ou indisponible, la zone garde donc toujours une
// image de voiture — elle n'est jamais vide.
// ==========================================================

export interface LuxeVideo {
  src: string;
  poster: string;
}

// URL directe d'une vidéo Pexels (lisible dans un <video>).
const mp4 = (id: string, file: string): string =>
  `https://videos.pexels.com/video-files/${id}/${file}`;

// Poster local : toujours disponible, servi par Next.js.
const local = (file: string): string => `/media/${file}`;

// ==========================================================
// VIDÉOS DE L'ACCUEIL
// ==========================================================

// Héro — passage de voitures de sport en mouvement.
export const HERO_VIDEO: LuxeVideo = {
  src: mp4('5309381', '5309381-hd_1920_1080_25fps.mp4'),
  poster: local('hero.jpg'),
};

// Section expérience — supercar de nuit en ville.
export const EXPERIENCE_VIDEO: LuxeVideo = {
  src: mp4('30843738', '13190445_2560_1440_24fps.mp4'),
  poster: local('experience.jpg'),
};

// Bandeau éditorial — vitrine de supercars.
export const EDITORIAL_VIDEO: LuxeVideo = {
  src: mp4('30678863', '13127658_1920_1080_24fps.mp4'),
  poster: local('editorial.jpg'),
};
