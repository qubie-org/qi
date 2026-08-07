import React from 'react'
import { Composition } from 'remotion'
import { Banner } from './Banner'

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Banner"
    component={Banner}
    durationInFrames={320}
    fps={30}
    width={1920}
    height={1080}
  />
)
