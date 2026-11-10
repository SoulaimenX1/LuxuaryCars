'use client';
import Link from 'next/link';
import {useEffect,useMemo,useState} from 'react';
import {useParams} from 'next/navigation';
import {Price} from '@/components/currency-provider';
import type {VehicleItem} from '@/lib/catalog-types';
import styles from './vehicle-detail.module.css';

type Review={id:string;rating:number;title:string;comment:string;serviceRating:number|null;serviceComment:string|null;reviewer:string;createdAt:string};
type EditorialReview={id:string;headline:string;body:string;verdict:string|null;source:string;createdAt:string};
type VehiclePhotos={photos:{id:string;url:string;alt:string}[]};
const emptyMedia:VehiclePhotos={photos:[]};
const PHOTO_ANGLE_LABELS=[
  'Main · front three-quarter',
  'Front · front view',
  'Rear · rear view',
  'Left · left profile',
  'Right · right profile',
];

export default function VehicleDetail(){
  const {id}=useParams<{id:string}>();
  const [vehicle,setVehicle]=useState<VehicleItem|null>(null);
  const [reviews,setReviews]=useState<Review[]>([]);
  const [editorial,setEditorial]=useState<EditorialReview[]>([]);
  const [media,setMedia]=useState<VehiclePhotos>(emptyMedia);
  const [activePhoto,setActivePhoto]=useState(0);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [isAdminUser,setIsAdminUser]=useState(false);

  useEffect(()=>{
    const controller=new AbortController();
    async function load(){try{
      const [catalogResponse,mediaResponse,reviewsResponse,editorialResponse,sessionResponse]=await Promise.all([
        fetch('/api/vehicles/catalog',{cache:'no-store',signal:controller.signal}),
        fetch(`/api/vehicles/media/${encodeURIComponent(id)}`,{cache:'no-store',signal:controller.signal}),
        fetch(`/api/premium/reviews/${encodeURIComponent(id)}`,{cache:'no-store',signal:controller.signal}),
        fetch(`/api/premium/editorial-reviews/${encodeURIComponent(id)}`,{cache:'no-store',signal:controller.signal}),
        fetch('/api/auth/session',{cache:'no-store',signal:controller.signal}),
      ]);
      if(!catalogResponse.ok)throw new Error('Vehicle catalogue unavailable');
      const catalog:VehicleItem[]=await catalogResponse.json();
      const found=catalog.find(c=>c.id===id);
      if(!found)throw new Error('This vehicle is no longer in the catalogue.');
      const assets:VehiclePhotos=mediaResponse.ok?await mediaResponse.json():emptyMedia;
      const feedback:Review[]=reviewsResponse.ok?await reviewsResponse.json():[];
      const editorials:EditorialReview[]=editorialResponse.ok?await editorialResponse.json():[];
      const sessionData:{user?:{role?:string}|null}=sessionResponse.ok?await sessionResponse.json():{user:null};
      if(!controller.signal.aborted){
        setVehicle(found);
        setMedia(assets);
        setReviews(feedback);
        setEditorial(editorials);
        setIsAdminUser(sessionData.user?.role==='admin'||sessionData.user?.role==='staff');
      }
    }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Unable to load vehicle');}
    finally{if(!controller.signal.aborted)setLoading(false);}}
    void load();return ()=>{};
  },[id]);

  // Titre d'onglet propre à la voiture : le layout « /vehicles » impose
  // « Our Fleet », ce qui laissait croire qu'on ouvrait la flotte.
  useEffect(()=>{
    if(vehicle) document.title=`${vehicle.brandName} ${vehicle.modelName} | Luxury Cars`;
  },[vehicle]);

  const photos=useMemo(()=>{
    const all=[...media.photos];
    // Les nouveaux médias ne doivent pas faire disparaître la photo historique.
    if(vehicle?.imageUrl&&!all.some(p=>p.url===vehicle.imageUrl))
      all.unshift({id:'primary',url:vehicle.imageUrl,alt:`${vehicle.brandName} ${vehicle.modelName}`});
    return all;
  },[media.photos,vehicle]);

  useEffect(()=>{
    if(photos.length<2)return;
    if(typeof window!=='undefined'&&window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
    const timer=window.setInterval(()=>setActivePhoto(x=>(x+1)%photos.length),4500);
    return ()=>window.clearInterval(timer);
  },[photos.length]);

  const photo=photos[Math.min(activePhoto,Math.max(0,photos.length-1))];
  const photoLabel=(index:number)=>photos.length>=5
    ? PHOTO_ANGLE_LABELS[index]??`Photo ${index+1}`
    : `Photo ${index+1}`;
  return <main className={styles.page}><div className={styles.wrap}>
    <Link href="/vehicles" className={styles.back}>← The collection</Link>
    {loading?<p className={styles.message}>Preparing your private viewing…</p>:error?<p role="alert" className={styles.message}>{error}</p>:vehicle&&<>
      <div className={styles.heading}>
        <div><p className={styles.eyebrow}>THE COLLECTION · {vehicle.categoryName}</p>
          <h1>{vehicle.brandName} <em>{vehicle.modelName}</em></h1>
          <p className={styles.summary}>{vehicle.description||'An exceptional driving experience, tailored to your journey.'}</p></div>
        <div className={styles.dailyPrice}><span>DAILY RATE FROM</span><strong><Price value={vehicle.dailyPrice}/></strong></div>
      </div>
      <section className={styles.gallery} aria-label="Vehicle photo gallery">
          {photo?<div className={styles.heroStage}>
              {photos.map((item,index)=><img key={item.id} src={item.url} alt={item.alt}
                className={index===activePhoto?styles.heroSlideActive:styles.heroSlide}
                loading={index===0?'eager':'lazy'} />)}
            </div>:<div className={styles.mediaEmpty}>Photos are being prepared for this vehicle.</div>}
          {photos.length>1&&<div className={styles.thumbs}>{photos.map((item,index)=><button key={item.id}
            type="button" onClick={()=>setActivePhoto(index)} className={activePhoto===index?styles.thumbActive:styles.thumb}
            aria-label={`View ${photoLabel(index)}`} aria-pressed={activePhoto===index}>
              <img src={item.url} alt={item.alt} loading="lazy"/>
              <span>{photoLabel(index)}</span>
            </button>)}</div>}
      </section>
      <div className={styles.grid}>
        <section className={styles.panel}><span className={styles.eyebrow}>PERFORMANCE & CRAFT</span>
          <h2>The finer details</h2>
          <dl className={styles.specs}>
            {([['Model year',vehicle.manufactureYear],['Power',vehicle.powerHp?`${vehicle.powerHp} HP`:'—'],
              ['Transmission',vehicle.transmission],['Seats',vehicle.seats],['Fuel',vehicle.fuelType],
              ['Engine',vehicle.engine||'—'],['0–100 km/h',vehicle.acceleration0To100?`${vehicle.acceleration0To100} s`:'—'],
              ['Top speed',vehicle.topSpeedKmh?`${vehicle.topSpeedKmh} km/h`:'—']] as [string,string|number][])
              .map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        </section>
        <section className={styles.panel}><span className={styles.eyebrow}>{isAdminUser?'ADMINISTRATION · FLEET':'PRIVATE RESERVATION'}</span>
          <h2>{isAdminUser?'Fleet management':'Your driving experience'}</h2><p>{isAdminUser?'Review pricing and manage availability from the control centre.':'Choose your rental dates before submitting your request.'}</p>
          <dl className={styles.specs}><div><dt>Daily rental</dt><dd><Price value={vehicle.dailyPrice}/></dd></div>
          <div><dt>Security deposit</dt><dd><Price value={vehicle.securityDeposit}/></dd></div>
          <div><dt>Vehicle value</dt><dd><Price value={vehicle.vehicleValue}/></dd></div></dl>
          {isAdminUser?<Link href="/admin/vehicles" className={styles.cta}>OPEN FLEET MANAGEMENT <span>→</span></Link>:<Link href={`/vehicles/${encodeURIComponent(vehicle.id)}/reserve`} className={styles.cta}>RESERVE THIS VEHICLE <span>→</span></Link>}
          <Link href="/contact" className={styles.ctaSecondary}>CONTACT US <span>→</span></Link>
          <p className={styles.finePrint}>Your vehicle and exact dates are checked before booking.</p>
        </section>
      </div>
      {editorial.length>0&&<section className={styles.panel}><span className={styles.eyebrow}>THE MAISON REVIEW</span>
        <h2>Our editorial take</h2>
        <div className={styles.editorial}>{editorial.map(er=><article key={er.id}>
          <h3>{er.headline}</h3>
          <p className={styles.editorialBody}>{er.body}</p>
          {er.verdict&&<p className={styles.editorialVerdict}>{er.verdict}</p>}
          <small>{er.source} · Editorial review</small></article>)}</div>
      </section>}
      <section className={styles.panel}><span className={styles.eyebrow}>CLIENT EXPERIENCE</span><h2>Verified guest experiences</h2>
        {reviews.length===0?<p>No customer reviews yet.</p>:<div className={styles.reviews}>{reviews.map(r=><article key={r.id}>
          <p aria-label={`${r.rating} out of 5 stars`}>{'★'.repeat(r.rating)}{'☆'.repeat(5-r.rating)}</p>
          <h3>{r.title}</h3><p>{r.comment}</p>
          {r.serviceRating!=null&&<div className={styles.serviceReview}>
            <p className={styles.serviceReviewLabel}>Service{typeof r.serviceRating==='number'?<> · <span aria-label={`${r.serviceRating} out of 5 stars`}>{'★'.repeat(r.serviceRating)}{'☆'.repeat(5-r.serviceRating)}</span></>:null}</p>
            {r.serviceComment&&<p>{r.serviceComment}</p>}
          </div>}
          <small>{r.reviewer} · Verified guest</small></article>)}</div>}
      </section>
    </>}
  </div></main>;
}
