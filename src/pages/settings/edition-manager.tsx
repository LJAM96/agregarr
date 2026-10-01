import type { GetServerSideProps, NextPage } from 'next';

const EditionManagerSettingsRedirectPage: NextPage = () => {
  return null;
};

export const getServerSideProps: GetServerSideProps = async () => {
  return {
    redirect: {
      destination: '/editions',
      permanent: true,
    },
  };
};

export default EditionManagerSettingsRedirectPage;
