/*
  © 2023 CVS Health and/or one of its affiliates. All rights reserved.

  MIT License

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
*/
exports.getSample = (population, sampleSize) => {
  const popSize = population.length;
  if (sampleSize < popSize) {
    const WeightedPopulation = population.map((item, index) => {
      const weight = 1 + Math.sin(Math.PI * index / popSize + Math.PI / 2);
      const priority = weight * Math.random();
      return [index, priority];
    });
    const sortedPopulation = WeightedPopulation.sort((a, b) => b[1] - a[1]);
    const sample = sortedPopulation.slice(0, sampleSize);
    const domOrderSample = sample.sort((a, b) => a[0] - b[0]);
    return domOrderSample.map((individual) => individual[0]);
  } else {
    return population.map((item, index) => index);
  }
};
