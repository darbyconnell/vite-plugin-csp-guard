import { useState } from "react";
import home2Stylesheet from "./Home2.css?url";

const Home2 = () => {
  const [clicks, setClicks] = useState(0);

  return (
    <>
      <link rel="stylesheet" href={home2Stylesheet} />
      <div className="home2">
        <h3>Home 2</h3>
        <button type="button" onClick={() => setClicks((c) => c + 1)}>
          Clicked {clicks} times
        </button>
      </div>
    </>
  );
};

export default Home2;
